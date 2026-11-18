import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  createInstagramContext: vi.fn(),
  assertContentPublishPermission: vi.fn(),
  getContentPublishingLimit: vi.fn(),
  createPublishContainer: vi.fn(),
  waitForContainer: vi.fn(),
  publishContainer: vi.fn(),
  createSignedDownload: vi.fn(),
  access: vi.fn(), account: vi.fn(), reserve: vi.fn(), begin: vi.fn(), finish: vi.fn(), recover: vi.fn(), release: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/billing/commercial-access", () => ({ assertCommercialAccess: mocks.access }));
vi.mock("@/lib/billing/commercial-capacity", () => ({ assertCommercialAccountUsable: mocks.account }));
vi.mock("@/lib/billing/commercial-usage", () => ({
  reserveCommercialUsage: mocks.reserve, beginCommercialDispatch: mocks.begin,
  finishCommercialDispatch: mocks.finish, recoverCommercialPublication: mocks.recover, releaseCommercialUsage: mocks.release,
}));
vi.mock("@/lib/queue/publishing-batch-progress", () => ({ refreshBatchProgress: mocks.refresh }));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    scheduledPublication: {
      findFirst: mocks.findFirst,
      updateMany: mocks.updateMany,
    },
    speedPostBatch: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/instagram/context", () => ({
  createInstagramContext: mocks.createInstagramContext,
}));

vi.mock("@/lib/instagram/publish-content", () => ({
  assertContentPublishPermission: mocks.assertContentPublishPermission,
  getContentPublishingLimit: mocks.getContentPublishingLimit,
  createPublishContainer: mocks.createPublishContainer,
  waitForContainer: mocks.waitForContainer,
  publishContainer: mocks.publishContainer,
}));

vi.mock("@/lib/publishing/storage", () => ({
  createSignedDownload: mocks.createSignedDownload,
}));

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: vi.fn(),
}));

vi.mock("bullmq", () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
  Worker: function MockWorker(_name: string, processor: unknown) {
    (globalThis as Record<string, unknown>).__publishingWorkerProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  },
}));

import { BillingError } from "@/lib/billing/config";
import { MetaApiError, RateLimitError, TokenExpiredError } from "@/lib/meta/client";
import { createPublishingWorker } from "@/lib/queue/publishing-worker";

const publication = {
  id: "publication_1",
  workspaceId: "workspace_1",
  instagramAccountId: "account_1",
  batchId: null,
  type: "REEL" as const,
  reelMode: "STANDARD" as const,
  caption: "Legenda",
  status: "PROCESSING" as const,
  idempotencyKey: "idempotency_1",
  metaContainerId: "container_1",
  metaMediaId: null,
  instagramAccount: { id: "account_1" },
  batch: null,
  assets: [{ asset: { mediaType: "VIDEO" as const, storagePath: "workspace/video.mp4" } }],
};

function processor() {
  createPublishingWorker();
  return (globalThis as Record<string, unknown>).__publishingWorkerProcessor as (job: {
    data: { publicationId: string; workspaceId: string };
  }) => Promise<void>;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue(undefined);
  mocks.account.mockResolvedValue(undefined);
  mocks.reserve.mockResolvedValue({ mode: "legacy", reservationId: null, status: null });
  mocks.begin.mockResolvedValue({ dispatchToken: "dispatch_1" });
  mocks.finish.mockResolvedValue(true);
  mocks.recover.mockResolvedValue(false);
  mocks.findFirst.mockResolvedValue({ ...publication });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.createInstagramContext.mockResolvedValue({
    provider: "META",
    instagramId: "instagram_1",
    accessToken: "access-token",
  });
  mocks.getContentPublishingLimit.mockResolvedValue({ quotaUsage: 1, quotaTotal: 50, quotaDurationSeconds: 86_400 });
  mocks.createSignedDownload.mockResolvedValue("https://signed.example/video.mp4");
});

describe("publishing worker idempotency", () => {
  it("does not publish when cancellation wins the processing claim", async () => {
    mocks.findFirst.mockResolvedValue({ ...publication, status: "QUEUED" });
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    await processor()({ data: { publicationId: publication.id, workspaceId: publication.workspaceId } });

    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.createInstagramContext).not.toHaveBeenCalled();
    expect(mocks.assertContentPublishPermission).not.toHaveBeenCalled();
    expect(mocks.getContentPublishingLimit).not.toHaveBeenCalled();
    expect(mocks.createPublishContainer).not.toHaveBeenCalled();
    expect(mocks.waitForContainer).not.toHaveBeenCalled();
    expect(mocks.publishContainer).not.toHaveBeenCalled();
  });

  it("recovers a published container even when the previous publish exhausted quota", async () => {
    mocks.getContentPublishingLimit.mockResolvedValue({ quotaUsage: 50, quotaTotal: 50, quotaDurationSeconds: 86_400 });
    mocks.waitForContainer.mockResolvedValue({ id: "container_1", status_code: "PUBLISHED" });

    await processor()({ data: { publicationId: publication.id, workspaceId: publication.workspaceId } });

    expect(mocks.getContentPublishingLimit).not.toHaveBeenCalled();
    expect(mocks.publishContainer).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PUBLISHED", metaStatus: "PUBLISHED_RECOVERED" }),
    }));
  });

  it("still blocks an unpublished existing container when quota is exhausted", async () => {
    mocks.getContentPublishingLimit.mockResolvedValue({ quotaUsage: 50, quotaTotal: 50, quotaDurationSeconds: 86_400 });
    mocks.waitForContainer.mockResolvedValue({ id: "container_1", status_code: "FINISHED" });

    await expect(processor()({ data: { publicationId: publication.id, workspaceId: publication.workspaceId } })).rejects.toThrow("quota exhausted");

    expect(mocks.publishContainer).not.toHaveBeenCalled();
    expect(mocks.createPublishContainer).not.toHaveBeenCalled();
  });

  it("does not create a new container when quota is already exhausted", async () => {
    mocks.findFirst.mockResolvedValue({ ...publication, metaContainerId: null });
    mocks.getContentPublishingLimit.mockResolvedValue({ quotaUsage: 50, quotaTotal: 50, quotaDurationSeconds: 86_400 });

    await expect(processor()({ data: { publicationId: publication.id, workspaceId: publication.workspaceId } })).rejects.toThrow("quota exhausted");

    expect(mocks.createPublishContainer).not.toHaveBeenCalled();
    expect(mocks.waitForContainer).not.toHaveBeenCalled();
    expect(mocks.publishContainer).not.toHaveBeenCalled();
  });

  it("does not call media_publish again when Meta already reports the container as published", async () => {
    mocks.waitForContainer.mockResolvedValue({ id: "container_1", status_code: "PUBLISHED" });

    await processor()({ data: { publicationId: publication.id, workspaceId: publication.workspaceId } });

    expect(mocks.publishContainer).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "PUBLISHED",
        metaStatus: "PUBLISHED_RECOVERED",
      }),
    }));
    const finalUpdate = mocks.updateMany.mock.calls.find(([args]) => args?.data?.status === "PUBLISHED");
    expect(finalUpdate?.[0].data).not.toHaveProperty("metaMediaId");
  });

  it("records the publish boundary and persists the media ID from a normal publish response", async () => {
    mocks.waitForContainer.mockResolvedValue({ id: "container_1", status_code: "FINISHED" });
    mocks.publishContainer.mockResolvedValue("media_1");

    await processor()({ data: { publicationId: publication.id, workspaceId: publication.workspaceId } });

    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { metaStatus: "PUBLISHING" },
    }));
    expect(mocks.publishContainer).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "PUBLISHED",
        metaStatus: "PUBLISHED",
        metaMediaId: "media_1",
      }),
    }));
  });
});

const job = { data: { publicationId: publication.id, workspaceId: publication.workspaceId } };
const commercial = { mode: "commercial", reservationId: "reservation_1", status: "RESERVED" };

describe("commercial publishing dispatch", () => {
  beforeEach(() => {
    mocks.reserve.mockResolvedValue(commercial);
    mocks.waitForContainer.mockResolvedValue({ id: "container_1", status_code: "FINISHED" });
    mocks.publishContainer.mockResolvedValue("media_1");
  });

  it("blocks an expired trial before signing private media or creating a container", async () => {
    mocks.findFirst.mockResolvedValue({ ...publication, metaContainerId: null });
    mocks.access.mockRejectedValue(new BillingError("COMMERCIAL_ACCESS_REQUIRED", 402));
    await expect(processor()(job)).rejects.toThrow("COMMERCIAL_ACCESS_REQUIRED");
    expect(mocks.createSignedDownload).not.toHaveBeenCalled();
    expect(mocks.createPublishContainer).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "FAILED", lastError: "COMMERCIAL_ACCESS_REQUIRED" },
    }));
  });

  it("blocks a downgraded account using its remote identity before media exposure", async () => {
    mocks.findFirst.mockResolvedValue({ ...publication, metaContainerId: null });
    mocks.account.mockRejectedValue(new BillingError("COMMERCIAL_ACCOUNT_LIMIT", 402));
    await expect(processor()(job)).rejects.toThrow("COMMERCIAL_ACCOUNT_LIMIT");
    expect(mocks.account).toHaveBeenCalledWith("workspace_1", "instagram_1");
    expect(mocks.createSignedDownload).not.toHaveBeenCalled();
    expect(mocks.publishContainer).not.toHaveBeenCalled();
  });

  it("revalidates expiry after the long container wait without reserving or publishing", async () => {
    mocks.findFirst.mockResolvedValue({ ...publication, metaContainerId: null });
    mocks.createPublishContainer.mockResolvedValue("container_1");
    mocks.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new BillingError("COMMERCIAL_ACCESS_REQUIRED", 402));
    await expect(processor()(job)).rejects.toThrow("COMMERCIAL_ACCESS_REQUIRED");
    expect(mocks.waitForContainer).toHaveBeenCalledOnce();
    expect(mocks.access).toHaveBeenCalledTimes(2);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.publishContainer).not.toHaveBeenCalled();
  });

  it("uses the persisted idempotency key and consumes one allowance only after confirmation", async () => {
    await processor()(job);
    expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith("workspace_1", "PUBLICATION", "idempotency_1");
    expect(mocks.begin).toHaveBeenCalledExactlyOnceWith("workspace_1", "reservation_1");
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith("workspace_1", "reservation_1", "dispatch_1", "CONFIRMED");
    expect(mocks.publishContainer).toHaveBeenCalledOnce();
    expect(mocks.waitForContainer.mock.invocationCallOrder[0]).toBeLessThan(mocks.reserve.mock.invocationCallOrder[0]);
    expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(mocks.publishContainer.mock.invocationCallOrder[0]);
  });

  it("limits late response enrichment to the missing ID on the same recovered publication", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    await processor()(job);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "publication_1", workspaceId: "workspace_1", metaContainerId: "container_1",
        status: "PUBLISHED", metaStatus: "PUBLISHED_RECOVERED", metaMediaId: null },
      data: { metaMediaId: "media_1", metaStatus: "PUBLISHED" },
    });
    expect(mocks.publishContainer).toHaveBeenCalledOnce();
  });

  it("does not publish a second operation when its allowance is exhausted", async () => {
    const run = processor();
    await run(job);
    mocks.reserve.mockRejectedValueOnce(new BillingError("COMMERCIAL_QUOTA_EXCEEDED", 402));
    await expect(run(job)).rejects.toThrow("COMMERCIAL_QUOTA_EXCEEDED");
    expect(mocks.publishContainer).toHaveBeenCalledOnce();
    expect(mocks.begin).toHaveBeenCalledOnce();
  });

  it("never dispatches an ambiguous previous operation again", async () => {
    mocks.reserve.mockResolvedValue({ ...commercial, status: "DISPATCHING" });
    mocks.begin.mockResolvedValue(null);
    await expect(processor()(job)).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
    expect(mocks.publishContainer).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("keeps an unknown Meta outcome held, stops retries, and preserves its container", async () => {
    mocks.publishContainer.mockRejectedValue(new TypeError("network response lost"));
    await expect(processor()(job)).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith("workspace_1", "reservation_1", "dispatch_1", "UNKNOWN");
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "FAILED", lastError: "PUBLICATION_OUTCOME_REVIEW_REQUIRED" },
    }));
    for (const [args] of mocks.updateMany.mock.calls) expect(args.data).not.toHaveProperty("metaContainerId", null);
  });

  it.each([undefined, null, "", 42, {}, "contains whitespace", "bad\nid", "x".repeat(2049)])("does not accept malformed publication receipts as proof: %#", async receipt => {
    mocks.publishContainer.mockResolvedValueOnce(receipt);
    await expect(processor()(job)).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith("workspace_1", "reservation_1", "dispatch_1", "UNKNOWN");
    expect(mocks.updateMany.mock.calls.some(([args]) => args.data.status === "PUBLISHED")).toBe(false);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each([
    new RateLimitError("fixture rate limit"), new TokenExpiredError("fixture token expired"),
    ...[10, 100, 200, 551].map(code => new MetaApiError(code, undefined, undefined, `fixture rejection ${code}`)),
  ])("releases a proven rejection and propagates the original error for BullMQ retry: %s", async error => {
    mocks.publishContainer.mockRejectedValueOnce(error);
    await expect(processor()(job)).rejects.toBe(error);
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith("workspace_1", "reservation_1", "dispatch_1", "DEFINITELY_REJECTED");
    expect(mocks.updateMany.mock.calls.some(([args]) => args.data.status === "FAILED")).toBe(false);
    expect(mocks.release).not.toHaveBeenCalled();
    await processor()(job);
    expect(mocks.reserve).toHaveBeenCalledTimes(2);
    expect(mocks.reserve.mock.calls[0]).toEqual(mocks.reserve.mock.calls[1]);
    expect(mocks.finish).toHaveBeenLastCalledWith("workspace_1", "reservation_1", "dispatch_1", "CONFIRMED");
    expect(mocks.publishContainer).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2, 500])("keeps Meta code %i unknown without releasing its hold", async code => {
    mocks.publishContainer.mockRejectedValueOnce(new MetaApiError(code, undefined, undefined, "fixture ambiguous response"));
    await expect(processor()(job)).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith("workspace_1", "reservation_1", "dispatch_1", "UNKNOWN");
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each(["failure", "lost owner"])("stops when persisting the proven rejection has a %s", async failure => {
    mocks.publishContainer.mockRejectedValueOnce(new RateLimitError("fixture rejection"));
    if (failure === "failure") mocks.finish.mockRejectedValueOnce(new Error("fixture persistence failure"));
    else mocks.finish.mockResolvedValueOnce(false);
    await expect(processor()(job)).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
    expect(mocks.publishContainer).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("rejects a reservation belonging to an earlier paid period without changing its key", async () => {
    mocks.begin.mockRejectedValue(new BillingError("USAGE_RESERVATION_STALE", 409));
    await expect(processor()(job)).rejects.toThrow("USAGE_RESERVATION_STALE");
    expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith("workspace_1", "PUBLICATION", "idempotency_1");
    expect(mocks.publishContainer).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("finalizes canonical PUBLISHED recovery despite expiry and never reserves a second allowance", async () => {
    mocks.waitForContainer.mockResolvedValue({ id: "container_1", status_code: "PUBLISHED" });
    mocks.access.mockRejectedValue(new BillingError("COMMERCIAL_ACCESS_REQUIRED", 402));
    await processor()(job);
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith("workspace_1", "idempotency_1", "container_1", undefined);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.publishContainer).not.toHaveBeenCalled();
  });

  it("recovers accounting for a locally PUBLISHED row before refreshing its batch", async () => {
    mocks.findFirst.mockResolvedValue({ ...publication, status: "PUBLISHED", metaMediaId: "media_1" });
    await processor()(job);
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith("workspace_1", "idempotency_1", "container_1", "media_1");
    expect(mocks.createInstagramContext).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it.each(["CANCELLED", "PAUSED"])("honors a batch %s that wins during processing", async (status) => {
    mocks.findFirst.mockResolvedValueOnce(publication).mockResolvedValueOnce({ status: "PROCESSING", batch: { status } });
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
    await processor()(job);
    expect(mocks.publishContainer).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith("workspace_1", "reservation_1", "dispatch_1", "DEFINITELY_REJECTED");
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ batchId: null }, { batch: { is: { status: { notIn: ["PAUSED", "CANCELLED"] } } } }] }),
      data: { metaStatus: "PUBLISHING" },
    }));
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: status === "PAUSED" ? "SCHEDULED" : "CANCELLED" } }));
    if (status === "CANCELLED") expect(mocks.release).toHaveBeenCalledWith("workspace_1", "reservation_1");
    else expect(mocks.release).not.toHaveBeenCalled();
  });

  it("preserves the legacy successful path without new database reads", async () => {
    mocks.reserve.mockResolvedValue({ mode: "legacy", reservationId: null, status: null });
    await processor()(job);
    expect(mocks.findFirst).toHaveBeenCalledOnce();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.publishContainer).toHaveBeenCalledOnce();
  });
});
