import { Queue } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "./client";

export const PUBLISHING_QUEUE_NAME = "instagram-publishing";
export const PUBLISH_JOB_NAME = "publish-instagram-content";

export interface PublishPublicationJob {
  publicationId: string;
  workspaceId: string;
}

let publishingQueue: Queue<PublishPublicationJob> | null = null;

export function getPublishingQueue(): Queue<PublishPublicationJob> {
  if (!publishingQueue) {
    publishingQueue = new Queue(PUBLISHING_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 2_000 },
      },
    });
  }
  return publishingQueue;
}

export function publishingJobId(idempotencyKey: string): string {
  // BullMQ custom ids cannot contain ':'. The DB key remains the source of truth.
  return `publication_${idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export async function enqueuePublication(args: {
  publicationId: string;
  workspaceId: string;
  idempotencyKey: string;
  scheduledFor?: Date | null;
  maxAttempts?: number;
}) {
  const delay = Math.max(0, (args.scheduledFor?.getTime() ?? Date.now()) - Date.now());
  const queue = getPublishingQueue();
  const jobId = publishingJobId(args.idempotencyKey);
  // A paused batch can let an already-active job finish without publishing.
  // BullMQ retains completed jobs, so clear that terminal placeholder before
  // re-enqueueing the same deterministic id on resume.
  const existing = await queue.getJob(jobId);
  if (existing && (await existing.isCompleted() || await existing.isFailed())) {
    await existing.remove();
  }
  return queue.add(PUBLISH_JOB_NAME, {
    publicationId: args.publicationId,
    workspaceId: args.workspaceId,
  }, {
    jobId,
    delay,
    attempts: args.maxAttempts ?? 5,
  });
}

/** Recovery sweep: claims due DB rows before enqueueing, so replicas cannot duplicate jobs. */
export async function enqueueDuePublications(now = new Date(), limit = 100): Promise<number> {
  const due = await prisma.scheduledPublication.findMany({
    where: {
      status: "SCHEDULED",
      scheduledFor: { lte: now },
      OR: [{ batchId: null }, { batch: { status: { in: ["SCHEDULED", "RUNNING"] } } }],
    },
    select: { id: true, workspaceId: true, idempotencyKey: true, scheduledFor: true, maxAttempts: true },
    orderBy: { scheduledFor: "asc" },
    take: limit,
  });
  let claimed = 0;
  for (const publication of due) {
    const result = await prisma.scheduledPublication.updateMany({
      where: { id: publication.id, workspaceId: publication.workspaceId, status: "SCHEDULED" },
      data: { status: "QUEUED" },
    });
    if (result.count !== 1) continue;
    try {
      await enqueuePublication({
        publicationId: publication.id,
        workspaceId: publication.workspaceId,
        idempotencyKey: publication.idempotencyKey,
        scheduledFor: publication.scheduledFor,
        maxAttempts: publication.maxAttempts,
      });
      claimed += 1;
    } catch (error) {
      await prisma.scheduledPublication.updateMany({
        where: { id: publication.id, workspaceId: publication.workspaceId, status: "QUEUED" },
        data: { status: "SCHEDULED" },
      });
      throw error;
    }
  }
  return claimed;
}
