import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(), getJob: vi.fn(), add: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { scheduledPublication: { findMany: mocks.findMany, updateMany: mocks.updateMany } } }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: class { getJob = mocks.getJob; add = mocks.add; } }));

let enqueueDuePublications: typeof import("@/lib/queue/publishing").enqueueDuePublications;
let publishingJobId: typeof import("@/lib/queue/publishing").publishingJobId;
let recoverQueuedPublications: typeof import("@/lib/queue/publishing").recoverQueuedPublications;

const now = new Date("2030-01-01T10:00:00Z");
const old = new Date("2030-01-01T09:00:00Z");
const row = { id: "publication", workspaceId: "workspace", idempotencyKey: "key-1", maxAttempts: 5, updatedAt: old };

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  ({ enqueueDuePublications, publishingJobId, recoverQueuedPublications } = await import("@/lib/queue/publishing"));
  mocks.findMany.mockResolvedValue([row]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.getJob.mockResolvedValue(undefined);
  mocks.add.mockResolvedValue({ id: publishingJobId(row.idempotencyKey) });
});
afterEach(() => vi.restoreAllMocks());

describe("publishing queued recovery", () => {
  it("repairs a stale DB claim with no Redis job using the original deterministic ID", async () => {
    expect(await recoverQueuedPublications(now)).toBe(1);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "QUEUED", attempts: 0, metaContainerId: null, metaMediaId: null, metaStatus: null, publishedAt: null,
        updatedAt: { lte: new Date("2030-01-01T09:55:00Z") },
        AND: [
          { OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
          { OR: [{ batchId: null }, { batch: { status: { in: ["SCHEDULED", "RUNNING"] } } }] },
        ],
      }),
    }));
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: row.id, workspaceId: row.workspaceId, status: "QUEUED", attempts: 0,
        metaContainerId: null, metaMediaId: null, metaStatus: null, publishedAt: null, AND: expect.any(Array),
      }),
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

  it("releases only its own unchanged QUEUED lease when Redis fails and continues", async () => {
    mocks.add.mockRejectedValue(new Error("Redis unavailable"));
    expect(await recoverQueuedPublications(now)).toBe(0);
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: { id: row.id, workspaceId: row.workspaceId, status: "QUEUED", updatedAt: now },
      data: { updatedAt: old },
    });
  });

  it.each(["inspection", "enqueue", "lease"])("recovers later rows after one %s failure", async (failure) => {
    const later = { ...row, id: "later", idempotencyKey: "later-key" };
    mocks.findMany.mockResolvedValue([row, later]);
    if (failure === "inspection") mocks.getJob.mockRejectedValueOnce(new Error("inspection failed"));
    if (failure === "enqueue") mocks.add.mockRejectedValueOnce(new Error("enqueue failed"));
    if (failure === "lease") mocks.updateMany.mockRejectedValueOnce(new Error("claim failed"));
    expect(await recoverQueuedPublications(now)).toBe(1);
    expect(mocks.add).toHaveBeenLastCalledWith("publish-instagram-content", {
      publicationId: later.id, workspaceId: later.workspaceId,
    }, expect.objectContaining({ jobId: publishingJobId(later.idempotencyKey) }));
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("still enqueues scheduled work when recovery and its lease release both fail", async () => {
    const due = { ...row, id: "scheduled", idempotencyKey: "scheduled-key", scheduledFor: old };
    mocks.findMany.mockResolvedValueOnce([row]).mockResolvedValueOnce([due]);
    mocks.getJob.mockRejectedValueOnce(new Error("Redis inspection failed"));
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error("release failed"));
    expect(await enqueueDuePublications(now)).toBe(1);
    expect(mocks.add).toHaveBeenCalledOnce();
    expect(mocks.add).toHaveBeenCalledWith("publish-instagram-content", {
      publicationId: due.id, workspaceId: due.workspaceId,
    }, expect.objectContaining({ jobId: publishingJobId(due.idempotencyKey) }));
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("bounds failure logging without queue or database logging and never exposes raw errors", async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({ ...row, id: `row-${index}` })));
    mocks.getJob.mockRejectedValue(new Error("redis://secret:password@redis.example"));
    expect(await recoverQueuedPublications(now)).toBe(0);
    expect(await recoverQueuedPublications(now)).toBe(0);
    expect(console.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("password");
    expect(mocks.add).not.toHaveBeenCalled();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    expect(await recoverQueuedPublications(now)).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("runs recovery from the normal publishing sweep", async () => {
    mocks.findMany.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    expect(await enqueueDuePublications(now)).toBe(1);
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });
});
