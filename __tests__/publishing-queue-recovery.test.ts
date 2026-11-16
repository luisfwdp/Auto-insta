import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(), getJob: vi.fn(), add: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { scheduledPublication: { findMany: mocks.findMany, updateMany: mocks.updateMany } } }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: class { getJob = mocks.getJob; add = mocks.add; } }));

import { enqueueDuePublications, publishingJobId, recoverQueuedPublications } from "@/lib/queue/publishing";

const now = new Date("2030-01-01T10:00:00Z");
const old = new Date("2030-01-01T09:00:00Z");
const row = { id: "publication", workspaceId: "workspace", idempotencyKey: "key-1", maxAttempts: 5, updatedAt: old };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([row]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.getJob.mockResolvedValue(undefined);
  mocks.add.mockResolvedValue({ id: publishingJobId(row.idempotencyKey) });
});

describe("publishing queued recovery", () => {
  it("repairs a stale DB claim with no Redis job using the original deterministic ID", async () => {
    expect(await recoverQueuedPublications(now)).toBe(1);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "QUEUED", updatedAt: { lte: new Date("2030-01-01T09:55:00Z") },
        AND: [
          { OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
          { OR: [{ batchId: null }, { batch: { status: { in: ["SCHEDULED", "RUNNING"] } } }] },
        ],
      }),
    }));
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: row.id, workspaceId: row.workspaceId, status: "QUEUED", AND: expect.any(Array) }),
      data: { updatedAt: now },
    }));
    expect(mocks.add).toHaveBeenCalledWith("publish-instagram-content", { publicationId: row.id, workspaceId: row.workspaceId }, {
      jobId: publishingJobId(row.idempotencyKey), attempts: 5,
    });
  });

  it.each(["active", "waiting", "delayed", "completed", "failed"])("never resends an existing %s job", async (state) => {
    const remove = vi.fn();
    mocks.getJob.mockResolvedValue({ state, remove });
    expect(await recoverQueuedPublications(now)).toBe(0);
    expect(mocks.add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it("skips a row when cancellation, pause, or another replica wins the lease", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(await recoverQueuedPublications(now)).toBe(0);
    expect(mocks.getJob).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("releases only its own unchanged QUEUED lease when Redis fails", async () => {
    mocks.add.mockRejectedValue(new Error("Redis unavailable"));
    await expect(recoverQueuedPublications(now)).rejects.toThrow("Redis unavailable");
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: { id: row.id, workspaceId: row.workspaceId, status: "QUEUED", updatedAt: now },
      data: { updatedAt: old },
    });
  });

  it("runs recovery from the normal publishing sweep", async () => {
    mocks.findMany.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    expect(await enqueueDuePublications(now)).toBe(1);
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });
});
