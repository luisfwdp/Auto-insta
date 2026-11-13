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
}));

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

vi.mock("@/lib/meta/client", () => ({
  RateLimitError: class RateLimitError extends Error {},
}));

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Worker: function MockWorker(_name: string, processor: unknown) {
    (globalThis as Record<string, unknown>).__publishingWorkerProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  },
}));

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
  vi.clearAllMocks();
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
