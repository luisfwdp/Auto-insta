import { Worker, type Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { createInstagramContext } from "@/lib/instagram/context";
import {
  assertContentPublishPermission,
  createPublishContainer,
  getContentPublishingLimit,
  publishContainer,
  waitForContainer,
  type PublishMediaInput,
} from "@/lib/instagram/publish-content";
import { createSignedDownload } from "@/lib/publishing/storage";
import { RateLimitError } from "@/lib/meta/client";
import { getRedisConnection } from "./client";
import {
  PUBLISHING_QUEUE_NAME,
  type PublishPublicationJob,
} from "./publishing";

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unknown publishing error";
}

async function refreshBatch(batchId: string | null) {
  if (!batchId) return;
  const [publishedItems, failedItems, batch] = await Promise.all([
    prisma.scheduledPublication.count({ where: { batchId, status: "PUBLISHED" } }),
    prisma.scheduledPublication.count({ where: { batchId, status: "FAILED" } }),
    prisma.speedPostBatch.findUnique({ where: { id: batchId }, select: { totalItems: true, status: true } }),
  ]);
  if (!batch || batch.status === "CANCELLED") return;
  const complete = publishedItems + failedItems >= batch.totalItems;
  await prisma.speedPostBatch.update({
    where: { id: batchId },
    data: {
      publishedItems,
      failedItems,
      ...(complete ? { status: failedItems > 0 ? "FAILED" : "COMPLETED", completedAt: new Date() } : {}),
    },
  });
}

async function mediaFor(publication: {
  type: "IMAGE_POST" | "CAROUSEL" | "REEL";
  reelMode: "STANDARD" | "TRIAL";
  assets: Array<{ asset: { mediaType: "IMAGE" | "VIDEO"; storagePath: string } }>;
}): Promise<PublishMediaInput> {
  const assets = await Promise.all(publication.assets.map(async ({ asset }) => ({
    kind: asset.mediaType,
    url: await createSignedDownload(asset.storagePath, 900),
  })));
  if (publication.type === "IMAGE_POST") {
    if (assets[0]?.kind !== "IMAGE") throw new Error("Image posts require an image asset");
    return { kind: "IMAGE", url: assets[0].url };
  }
  if (publication.type === "REEL") {
    if (assets[0]?.kind !== "VIDEO") throw new Error("Reels require a video asset");
    return { kind: "REEL", url: assets[0].url, trial: publication.reelMode === "TRIAL" };
  }
  return {
    kind: "CAROUSEL",
    children: assets.map((asset) => ({
      kind: asset.kind === "VIDEO" ? "VIDEO" as const : "IMAGE" as const,
      url: asset.url,
    })),
  };
}

async function processPublication(job: Job<PublishPublicationJob>) {
  const publication = await prisma.scheduledPublication.findFirst({
    where: { id: job.data.publicationId, workspaceId: job.data.workspaceId },
    include: {
      instagramAccount: true,
      batch: { select: { id: true, status: true } },
      assets: { orderBy: { position: "asc" }, include: { asset: true } },
    },
  });
  if (!publication || publication.status === "CANCELLED" || publication.status === "PUBLISHED") return;
  if (publication.batch && ["PAUSED", "CANCELLED"].includes(publication.batch.status)) {
    await prisma.scheduledPublication.updateMany({
      where: { id: publication.id, workspaceId: publication.workspaceId, status: "QUEUED" },
      data: { status: publication.batch.status === "PAUSED" ? "SCHEDULED" : "CANCELLED" },
    });
    return;
  }
  if (!(["QUEUED", "PROCESSING"] as string[]).includes(publication.status)) return;

  await prisma.scheduledPublication.updateMany({
    where: { id: publication.id, workspaceId: publication.workspaceId, status: { in: ["QUEUED", "PROCESSING"] } },
    data: { status: "PROCESSING", attempts: { increment: 1 }, lastError: null },
  });
  if (publication.batchId) await prisma.speedPostBatch.updateMany({
    where: { id: publication.batchId, workspaceId: publication.workspaceId, status: "SCHEDULED" },
    data: { status: "RUNNING" },
  });

  const context = await createInstagramContext(publication.instagramAccount, publication.idempotencyKey);
  if (context.provider !== "META") throw new Error("Content publishing requires an official Meta connection");
  await assertContentPublishPermission(context.accessToken);
  const quota = await getContentPublishingLimit(context.instagramId, context.accessToken);
  if (quota.quotaUsage >= quota.quotaTotal)
    throw new RateLimitError(`Instagram publishing quota exhausted (${quota.quotaUsage}/${quota.quotaTotal})`);

  let containerId = publication.metaContainerId;
  if (!containerId) {
    containerId = await createPublishContainer(
      context.instagramId,
      context.accessToken,
      await mediaFor(publication),
      publication.caption ?? ""
    );
    await prisma.scheduledPublication.updateMany({
      where: { id: publication.id, workspaceId: publication.workspaceId, status: "PROCESSING" },
      data: { metaContainerId: containerId, metaStatus: "IN_PROGRESS" },
    });
  }

  const state = await waitForContainer(containerId, context.accessToken);
  // If a previous attempt published but crashed before its DB update, stop here:
  // never call media_publish twice for the same container.
  const mediaId = state.status_code === "PUBLISHED"
    ? publication.metaMediaId
    : await publishContainer(context.instagramId, context.accessToken, containerId);
  await prisma.scheduledPublication.updateMany({
    where: { id: publication.id, workspaceId: publication.workspaceId, status: "PROCESSING" },
    data: {
      status: "PUBLISHED",
      metaStatus: "PUBLISHED",
      metaMediaId: mediaId,
      publishedAt: new Date(),
      lastError: null,
    },
  });
  await refreshBatch(publication.batchId);
}

export function createPublishingWorker(): Worker<PublishPublicationJob> {
  const worker = new Worker<PublishPublicationJob>(PUBLISHING_QUEUE_NAME, processPublication, {
    connection: getRedisConnection(),
    concurrency: Number(process.env.PUBLISHING_WORKER_CONCURRENCY ?? 2),
  });
  worker.on("completed", (job) => console.log(`[Publishing Worker] Job ${job.id} completed`));
  worker.on("failed", (job, error) => {
    console.error(`[Publishing Worker] Job ${job?.id ?? "unknown"} failed: ${message(error)}`);
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    void prisma.scheduledPublication.updateMany({
      where: { id: job.data.publicationId, workspaceId: job.data.workspaceId, status: "PROCESSING" },
      data: { status: "FAILED", lastError: message(error) },
    }).then(() => prisma.scheduledPublication.findFirst({
      where: { id: job.data.publicationId, workspaceId: job.data.workspaceId }, select: { batchId: true },
    })).then((row) => refreshBatch(row?.batchId ?? null)).catch((recordError) => {
      console.error("[Publishing Worker] Failed to persist terminal failure:", message(recordError));
    });
  });
  return worker;
}
