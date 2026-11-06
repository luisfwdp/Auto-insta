import type { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";

/**
 * Proof that the BullMQ consumer really processes jobs, not just that the
 * process can reach Redis. While the consumer is ready, the worker enqueues a
 * diagnostic job on the DM queue; processing it only stamps a Redis key. It
 * never touches the database or Meta, so it cannot send anything.
 *
 * The job id is fixed: BullMQ ignores an add while a job with that id exists,
 * so a stalled consumer leaves at most one canary waiting, never a backlog.
 */
export const CANARY_JOB_NAME = "worker-canary";
export const CANARY_JOB_ID = "worker-canary";
export const CANARY_KEY = "health:worker:canary";
/** A canary is enqueued every heartbeat (30 s); older than this means stalled. */
export const CANARY_MAX_AGE_MS = 180_000;

export async function enqueueCanary(queue: Pick<Queue, "add">): Promise<void> {
  await queue.add(
    CANARY_JOB_NAME,
    { canary: true } as never,
    { jobId: CANARY_JOB_ID, attempts: 1, removeOnComplete: true, removeOnFail: true }
  );
}

export async function recordCanaryProcessed(now = new Date()): Promise<void> {
  await getRedisConnection().set(CANARY_KEY, now.toISOString(), "EX", 600);
}

export async function getLastCanaryAt(): Promise<string | null> {
  return getRedisConnection().get(CANARY_KEY);
}

export type ConsumerState = "processing" | "stalled";

/** "processing" only when a canary was processed within CANARY_MAX_AGE_MS. */
export function evaluateConsumer(lastCanaryAt: string | null, now = Date.now()) {
  const ageMs = lastCanaryAt ? now - new Date(lastCanaryAt).getTime() : null;
  const state: ConsumerState =
    ageMs !== null && ageMs >= 0 && ageMs <= CANARY_MAX_AGE_MS ? "processing" : "stalled";
  return { state, lastProcessedAt: lastCanaryAt, ageMs };
}
