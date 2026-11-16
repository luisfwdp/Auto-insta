import { Queue } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "./client";

export const PUBLISHING_QUEUE_NAME = "instagram-publishing";
export const PUBLISH_JOB_NAME = "publish-instagram-content";
const QUEUED_RECOVERY_LEASE_MS = 5 * 60_000;

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

/** Repair a crash between the DB claim and Redis enqueue without restarting existing jobs. */
export async function recoverQueuedPublications(now = new Date(), limit = 100): Promise<number> {
  const staleBefore = new Date(now.getTime() - QUEUED_RECOVERY_LEASE_MS);
  const eligible = {
    status: "QUEUED" as const,
    updatedAt: { lte: staleBefore },
    AND: [
      { OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
      { OR: [{ batchId: null }, { batch: { status: { in: ["SCHEDULED" as const, "RUNNING" as const] } } }] },
    ],
  };
  const stale = await prisma.scheduledPublication.findMany({
    where: eligible,
    select: { id: true, workspaceId: true, idempotencyKey: true, maxAttempts: true, updatedAt: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  const queue = getPublishingQueue();
  let recovered = 0;
  for (const publication of stale) {
    // Refresh the inspection lease even for existing jobs, so a large backlog
    // cannot permanently hide later orphaned rows behind the scan limit.
    const claim = await prisma.scheduledPublication.updateMany({
      where: { ...eligible, id: publication.id, workspaceId: publication.workspaceId },
      data: { updatedAt: now },
    });
    if (claim.count !== 1) continue;
    try {
      const jobId = publishingJobId(publication.idempotencyKey);
      // Never remove or restart an existing job, including completed/failed
      // jobs: their external-call history must remain authoritative.
      if (await queue.getJob(jobId)) continue;
      await queue.add(PUBLISH_JOB_NAME, {
        publicationId: publication.id,
        workspaceId: publication.workspaceId,
      }, { jobId, attempts: publication.maxAttempts });
      recovered += 1;
    } catch (error) {
      await prisma.scheduledPublication.updateMany({
        where: { id: publication.id, workspaceId: publication.workspaceId, status: "QUEUED", updatedAt: now },
        data: { updatedAt: publication.updatedAt },
      });
      throw error;
    }
  }
  return recovered;
}

/** Claims due DB rows before enqueueing, so replicas cannot duplicate jobs. */
export async function enqueueDuePublications(now = new Date(), limit = 100): Promise<number> {
  const recovered = await recoverQueuedPublications(now, limit);
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
  let claimed = recovered;
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
