import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { trackConsumerReadiness } from "@/lib/ops/worker-readiness";
import { enqueueCanary } from "@/lib/ops/worker-canary";
import { getDMQueue } from "@/lib/queue/client";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { attachPendingNextReels } from "@/lib/automation/attach-next-reel";
import { createPublishingWorker } from "@/lib/queue/publishing-worker";
import { enqueueDuePublications } from "@/lib/queue/publishing";
import os from "node:os";

const worker = createDMWorker();
const publishingWorker = createPublishingWorker();
const readiness = trackConsumerReadiness(worker);
const publishingReadiness = trackConsumerReadiness(publishingWorker);
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);
const PUBLISHING_SWEEP_INTERVAL_MS = Number(
  process.env.PUBLISHING_SWEEP_INTERVAL_MS ?? 30_000
);

console.log("[DM Worker] Started");

async function heartbeat() {
  // Only report healthy while the BullMQ consumer is connected; otherwise let
  // the heartbeat expire so /api/health shows the queue is not being served.
  if (!readiness.isReady() || !publishingReadiness.isReady()) {
    console.warn("[Worker] One or more consumers not ready; skipping heartbeat", {
      dm: readiness.isReady(),
      publishing: publishingReadiness.isReady(),
    });
    return;
  }
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
      // The overall worker became ready only when its last consumer did.
      consumerReadySince: [readiness.readySince(), publishingReadiness.readySince()]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null,
    });
    // Health requires this canary to be processed, so a consumer that is
    // "ready" but no longer takes jobs still turns /api/health unhealthy.
    await enqueueCanary(getDMQueue());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    const attached = await attachPendingNextReels();
    if (attached.bound > 0 || attached.failedAccounts > 0) {
      console.log("[DM Worker] Next-reel attachment:", attached);
    }
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

async function sweepPublishing() {
  try {
    const queued = await enqueueDuePublications();
    if (queued > 0) console.log(`[Publishing Worker] Enqueued ${queued} due publication(s)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Publishing Worker] Due-publication sweep failed:", message);
  }
}

void sweepPublishing();
const publishingSweepTimer = setInterval(
  () => void sweepPublishing(),
  PUBLISHING_SWEEP_INTERVAL_MS
);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(publishingSweepTimer);
  await Promise.all([worker.close(), publishingWorker.close()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
