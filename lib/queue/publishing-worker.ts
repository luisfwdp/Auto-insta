import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import { assertCommercialAccess } from "@/lib/billing/commercial-access";
import { assertCommercialAccountUsable } from "@/lib/billing/commercial-capacity";
import { BillingError } from "@/lib/billing/config";
import {
  beginCommercialDispatch, finishCommercialDispatch, recoverCommercialPublication,
  releaseCommercialUsage, reserveCommercialUsage,
} from "@/lib/billing/commercial-usage";
import { prisma } from "@/lib/db/client";
import { createInstagramContext } from "@/lib/instagram/context";
import { isConfirmedSendRejection } from "@/lib/instagram/delivery-errors";
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
import { refreshBatchProgress } from "./publishing-batch-progress";
import {
  PUBLISHING_QUEUE_NAME,
  type PublishPublicationJob,
} from "./publishing";

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unknown publishing error";
}

/** Meta's publishing window is rolling, so an exhausted quota frees up by itself. */
export const PUBLISHING_QUOTA_WAITING = "PUBLISHING_QUOTA_WAITING";
export const QUOTA_RETRY_DELAY_MS = 30 * 60_000;
export const QUOTA_MAX_WAIT_MS = 24 * 60 * 60_000;

export class PublishingQuotaExhaustedError extends RateLimitError {
  constructor(usage: number, total: number) {
    super(`Instagram publishing quota exhausted (${usage}/${total})`);
    this.name = "PublishingQuotaExhaustedError";
  }
}

async function assertPublishingQuota(instagramId: string, accessToken: string) {
  const quota = await getContentPublishingLimit(instagramId, accessToken);
  if (quota.quotaUsage >= quota.quotaTotal)
    throw new PublishingQuotaExhaustedError(quota.quotaUsage, quota.quotaTotal);
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

async function publishPublication(job: Job<PublishPublicationJob>) {
  const publication = await prisma.scheduledPublication.findFirst({
    where: { id: job.data.publicationId, workspaceId: job.data.workspaceId },
    include: {
      instagramAccount: true,
      batch: { select: { id: true, status: true } },
      assets: { orderBy: { position: "asc" }, include: { asset: true } },
    },
  });
  if (!publication || publication.status === "CANCELLED") return;
  if (publication.status === "PUBLISHED") {
    // An earlier attempt may have published before its batch refresh failed.
    if (publication.metaContainerId) await recoverCommercialPublication(publication.workspaceId,
      publication.idempotencyKey, publication.metaContainerId, publication.metaMediaId ?? undefined);
    await refreshBatchProgress(publication.batchId, publication.workspaceId);
    return;
  }
  if (publication.batch && ["PAUSED", "CANCELLED"].includes(publication.batch.status)) {
    await prisma.scheduledPublication.updateMany({
      where: { id: publication.id, workspaceId: publication.workspaceId, status: "QUEUED" },
      data: { status: publication.batch.status === "PAUSED" ? "SCHEDULED" : "CANCELLED" },
    });
    return;
  }
  if (!(["QUEUED", "PROCESSING"] as string[]).includes(publication.status)) return;

  const claim = await prisma.scheduledPublication.updateMany({
    where: { id: publication.id, workspaceId: publication.workspaceId, status: { in: ["QUEUED", "PROCESSING"] } },
    data: { status: "PROCESSING", attempts: { increment: 1 }, lastError: null },
  });
  // A batch cancellation can win after the initial read. Only the worker that
  // still owns a processable publication may make external publishing calls.
  if (claim.count !== 1) return;
  if (publication.batchId) await prisma.speedPostBatch.updateMany({
    where: { id: publication.batchId, workspaceId: publication.workspaceId, status: "SCHEDULED" },
    data: { status: "RUNNING" },
  });

  const context = await createInstagramContext(publication.instagramAccount, publication.idempotencyKey);
  if (context.provider !== "META") throw new Error("Content publishing requires an official Meta connection");
  await assertContentPublishPermission(context.accessToken);

  let containerId = publication.metaContainerId;
  if (!containerId) {
    // Creating a container exposes signed private media to Meta. Gate it even
    // though only the final media_publish consumes the publication allowance.
    await assertCommercialAccess(publication.workspaceId);
    await assertCommercialAccountUsable(publication.workspaceId, context.instagramId);
    await assertPublishingQuota(context.instagramId, context.accessToken);
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
  const recoveredPublishedContainer = state.status_code === "PUBLISHED";
  let mediaId = publication.metaMediaId;
  if (recoveredPublishedContainer) {
    // Finalize already-made effects even when the trial has expired meanwhile.
    await recoverCommercialPublication(publication.workspaceId, publication.idempotencyKey,
      containerId, mediaId ?? undefined);
  } else {
    // Container processing can take minutes. Never rely on the access decision
    // made before it started, or on a stale cancellation/batch snapshot.
    await assertCommercialAccess(publication.workspaceId);
    await assertCommercialAccountUsable(publication.workspaceId, context.instagramId);
    // An existing container may have consumed the last quota slot on an earlier
    // attempt. Recover PUBLISHED first; quota only gates a new publish request.
    if (publication.metaContainerId)
      await assertPublishingQuota(context.instagramId, context.accessToken);
    const reservation = await reserveCommercialUsage(publication.workspaceId, "PUBLICATION", publication.idempotencyKey);
    const dispatch = reservation.mode === "commercial"
      ? await beginCommercialDispatch(publication.workspaceId, reservation.reservationId)
      : null;
    if (reservation.mode === "commercial" && !dispatch)
      throw new BillingError("PUBLICATION_OUTCOME_REVIEW_REQUIRED", 409);
    // Persist the external-call boundary before media_publish. The Graph API
    // returns the final media ID only in the publish response, so a process
    // crash after Meta accepts the request cannot safely reconstruct that ID.
    // The container's later PUBLISHED status is authoritative, however, and
    // lets a retry finish without issuing a duplicate publish request.
    const boundary = await prisma.scheduledPublication.updateMany({
      where: { id: publication.id, workspaceId: publication.workspaceId, status: "PROCESSING",
        OR: [{ batchId: null }, { batch: { is: { status: { notIn: ["PAUSED", "CANCELLED"] } } } }] },
      data: { metaStatus: "PUBLISHING" },
    });
    if (boundary.count !== 1) {
      // No external call occurred: relinquish only our dispatch claim. A pause
      // keeps the reservation reusable; a permanent cancel can release it.
      if (reservation.mode === "commercial" && dispatch)
        await finishCommercialDispatch(publication.workspaceId, reservation.reservationId, dispatch.dispatchToken, "DEFINITELY_REJECTED");
      const current = await prisma.scheduledPublication.findFirst({
        where: { id: publication.id, workspaceId: publication.workspaceId },
        select: { status: true, batch: { select: { status: true } } },
      });
      const cancelled = current?.status === "CANCELLED" || current?.batch?.status === "CANCELLED";
      if (cancelled && reservation.mode === "commercial") await releaseCommercialUsage(publication.workspaceId, reservation.reservationId);
      if (current?.batch && ["PAUSED", "CANCELLED"].includes(current.batch.status))
        await prisma.scheduledPublication.updateMany({ where: { id: publication.id, workspaceId: publication.workspaceId, status: "PROCESSING" },
          data: { status: cancelled ? "CANCELLED" : "SCHEDULED" } });
      return;
    }
    try {
      mediaId = await publishContainer(context.instagramId, context.accessToken, containerId);
      // A successful HTTP response without the provider's media ID cannot
      // prove publication. Keep the dispatch held until canonical recovery.
      if (typeof mediaId !== "string" || !/^[!-~]{1,2048}$/.test(mediaId))
        throw new BillingError("PUBLICATION_OUTCOME_REVIEW_REQUIRED", 409);
    } catch (error) {
      if (reservation.mode !== "commercial") throw error;
      // Only an explicit provider rejection proves no publication occurred.
      // It releases the hold; a retry must reserve and revalidate again. Lost
      // responses, 5xx and persistence failures need canonical recovery.
      const rejected = isConfirmedSendRejection(error);
      let finished: boolean;
      try {
        finished = await finishCommercialDispatch(publication.workspaceId, reservation.reservationId,
          dispatch!.dispatchToken, rejected ? "DEFINITELY_REJECTED" : "UNKNOWN");
      } catch { throw new BillingError("PUBLICATION_OUTCOME_REVIEW_REQUIRED", 409); }
      if (rejected && finished) throw error;
      throw new BillingError("PUBLICATION_OUTCOME_REVIEW_REQUIRED", 409);
    }
    if (reservation.mode === "commercial")
      await finishCommercialDispatch(publication.workspaceId, reservation.reservationId, dispatch!.dispatchToken, "CONFIRMED");
  }
  const finalized = await prisma.scheduledPublication.updateMany({
    // A stalled duplicate may have raised REVIEW while the real dispatch was
    // in flight. Its valid receipt/canonical PUBLISHED proof takes precedence,
    // bound to this same tenant and container; other failures stay untouched.
    where: { id: publication.id, workspaceId: publication.workspaceId, metaContainerId: containerId,
      OR: [{ status: "PROCESSING" }, { status: "FAILED", lastError: "PUBLICATION_OUTCOME_REVIEW_REQUIRED" },
        // Cancellation cannot retract a Graph call already accepted in flight.
        // Record only that proven effect, retaining the cancellation timestamp
        // and batch intent; this branch never dispatches a canceled job.
        { status: "CANCELLED", lastError: "PUBLICATION_OUTCOME_REVIEW_REQUIRED", metaStatus: "PUBLISHING", cancelledAt: { not: null } }] },
    data: {
      status: "PUBLISHED",
      // Preserve an explicit recovery marker when Meta confirms publication
      // but the original media_publish response (and its media ID) was lost.
      metaStatus: recoveredPublishedContainer && !mediaId ? "PUBLISHED_RECOVERED" : "PUBLISHED",
      ...(mediaId ? { metaMediaId: mediaId } : {}),
      publishedAt: new Date(),
      lastError: null,
    },
  });
  if (finalized.count === 0 && !recoveredPublishedContainer && mediaId) {
    // Canonical recovery may win before the original publish response returns.
    // Enrich only its missing receipt; preserve timestamps and cancellation.
    await prisma.scheduledPublication.updateMany({
      where: { id: publication.id, workspaceId: publication.workspaceId, metaContainerId: containerId,
        status: "PUBLISHED", metaStatus: "PUBLISHED_RECOVERED", metaMediaId: null },
      data: { metaMediaId: mediaId, metaStatus: "PUBLISHED" },
    });
  }
  await refreshBatchProgress(publication.batchId, publication.workspaceId);
}

/**
 * The account already used its Meta allowance for the rolling 24 hours. Nothing
 * was sent for this publication, so hand it back to the queue and look again
 * later without spending one of its attempts. Returns false once the wait
 * would exceed a full window, so the normal failure path reports it.
 */
async function waitForPublishingQuota(job: Job<PublishPublicationJob>, token: string | undefined, now = Date.now()) {
  if (!token) return false;
  const where = { id: job.data.publicationId, workspaceId: job.data.workspaceId };
  const row = await prisma.scheduledPublication.findFirst({ where, select: { scheduledFor: true, createdAt: true } });
  const due = (row?.scheduledFor ?? row?.createdAt)?.getTime();
  if (!due || now - due >= QUOTA_MAX_WAIT_MS) return false;
  const released = await prisma.scheduledPublication.updateMany({
    where: { ...where, status: "PROCESSING" },
    data: { status: "QUEUED", lastError: PUBLISHING_QUOTA_WAITING },
  });
  if (released.count !== 1) return false;
  await job.moveToDelayed(now + QUOTA_RETRY_DELAY_MS, token);
  return true;
}

async function processPublication(job: Job<PublishPublicationJob>, token?: string) {
  try {
    await publishPublication(job);
  } catch (error) {
    if (error instanceof PublishingQuotaExhaustedError && await waitForPublishingQuota(job, token))
      throw new DelayedError();
    if (!(error instanceof BillingError)) throw error;
    // BullMQ stops retrying UnrecoverableError before attemptsMade reaches the
    // configured maximum, so persist terminal commercial failures here.
    await prisma.scheduledPublication.updateMany({
      where: { id: job.data.publicationId, workspaceId: job.data.workspaceId, status: "PROCESSING" },
      data: { status: "FAILED", lastError: error.code },
    });
    const row = await prisma.scheduledPublication.findFirst({
      where: { id: job.data.publicationId, workspaceId: job.data.workspaceId }, select: { batchId: true },
    });
    await refreshBatchProgress(row?.batchId ?? null, job.data.workspaceId);
    throw new UnrecoverableError(error.code);
  }
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
    })).then((row) => refreshBatchProgress(row?.batchId ?? null, job.data.workspaceId)).catch((recordError) => {
      console.error("[Publishing Worker] Failed to persist terminal failure:", message(recordError));
    });
  });
  return worker;
}
