import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/server";
import { prisma } from "@/lib/db/client";
import {
  batchActionSchema,
  createBatchSchema,
  publicationInputSchema,
  type CreateBatchInput,
} from "@/lib/publishing/schemas";
import { generateBatchSchedule, orderBatchItems } from "@/lib/publishing/schedule";

type PublicationInput = z.infer<typeof publicationInputSchema>;
type BatchAction = z.infer<typeof batchActionSchema>["action"];

export type McpPublishingService = {
  listMedia(): Promise<unknown>;
  listPublications(): Promise<unknown>;
  listBatches(): Promise<unknown>;
  createPublication(input: PublicationInput): Promise<unknown>;
  createBatch(input: CreateBatchInput): Promise<unknown>;
  manageBatch(id: string, action: BatchAction): Promise<unknown>;
};

function configuredWorkspaceId(explicitWorkspaceId?: string) {
  const workspaceId = explicitWorkspaceId?.trim() || process.env.PINGCHAT_MCP_WORKSPACE_ID?.trim();
  if (!workspaceId) throw new Error("PINGCHAT_MCP_WORKSPACE_ID is required for publishing tools");
  return workspaceId;
}

const publicationInclude = {
  instagramAccount: { select: { id: true, username: true, name: true } },
  assets: {
    orderBy: { position: "asc" as const },
    include: {
      asset: {
        select: { id: true, filename: true, mimeType: true, mediaType: true, status: true },
      },
    },
  },
};

export function createPrismaMcpPublishingService(workspace?: string): McpPublishingService {
  const workspaceId = configuredWorkspaceId(workspace);

  async function assertRelations(accountId: string, assetIds: string[], videosOnly = false) {
    const [account, assets] = await Promise.all([
      prisma.instagramAccount.findFirst({
        where: { id: accountId, workspaceId },
        select: { id: true },
      }),
      prisma.publishingAsset.findMany({
        where: {
          id: { in: assetIds },
          workspaceId,
          status: "READY",
          ...(videosOnly ? { mediaType: "VIDEO" as const } : {}),
        },
        select: { id: true, filename: true, mediaType: true },
      }),
    ]);
    if (!account) throw new Error("Instagram account not found in the authorized workspace");
    if (assets.length !== assetIds.length) throw new Error("One or more media items are unavailable");
    return assets;
  }

  return {
    listMedia() {
      return prisma.publishingAsset.findMany({
        where: { workspaceId, status: "READY" },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          mediaType: true,
          byteSize: true,
          width: true,
          height: true,
          durationMs: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
    },
    listPublications() {
      return prisma.scheduledPublication.findMany({
        where: { workspaceId },
        orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
        take: 200,
        include: publicationInclude,
      });
    },
    listBatches() {
      return prisma.speedPostBatch.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          instagramAccount: { select: { id: true, username: true, name: true } },
        },
      });
    },
    async createPublication(input) {
      const assets = await assertRelations(input.instagramAccountId, input.assetIds);
      if (input.type === "REEL" && assets[0]?.mediaType !== "VIDEO") {
        throw new Error("A Reel requires a video");
      }
      if (input.type === "IMAGE_POST" && assets[0]?.mediaType !== "IMAGE") {
        throw new Error("An image post requires a JPEG image");
      }
      const scheduledFor = input.publishNow
        ? new Date()
        : input.scheduledFor
          ? new Date(input.scheduledFor)
          : null;
      return prisma.scheduledPublication.create({
        data: {
          workspaceId,
          instagramAccountId: input.instagramAccountId,
          type: input.type,
          reelMode: input.reelMode,
          caption: input.caption,
          scheduledFor,
          timezone: input.timezone,
          status: scheduledFor ? "SCHEDULED" : "DRAFT",
          idempotencyKey: randomUUID(),
          assets: {
            create: input.assetIds.map((assetId, position) => ({ assetId, position })),
          },
        },
        include: publicationInclude,
      });
    },
    async createBatch(input) {
      const assetIds = input.items.map((item) => item.assetId);
      const assets = await assertRelations(input.instagramAccountId, assetIds, true);
      const randomSeed = input.orderMode === "RANDOM" ? randomUUID() : null;
      const filenames = new Map(assets.map((asset) => [asset.id, asset.filename]));
      const ordered = orderBatchItems(
        input.items,
        input.orderMode,
        randomSeed ?? "sequential",
        filenames
      );
      const schedule = input.scheduleMode === "CUSTOM"
        ? ordered.map((item) => new Date(item.scheduledFor!))
        : generateBatchSchedule(input, ordered.length);
      if (schedule.some((date) => date.getTime() <= Date.now())) {
        throw new Error("All generated dates must be in the future");
      }
      return prisma.speedPostBatch.create({
        data: {
          workspaceId,
          instagramAccountId: input.instagramAccountId,
          name: input.name,
          status: "SCHEDULED",
          postsPerDay: input.postsPerDay,
          scheduleMode: input.scheduleMode,
          orderMode: input.orderMode,
          timezone: input.timezone,
          timeSlots: input.timeSlots,
          defaultCaption: input.defaultCaption,
          reelMode: input.reelMode,
          startsOn: new Date(`${input.startsOn}T00:00:00.000Z`),
          totalItems: ordered.length,
          randomSeed,
          publications: {
            create: ordered.map((item, index) => ({
              workspaceId,
              instagramAccountId: input.instagramAccountId,
              type: "REEL",
              reelMode: input.reelMode,
              caption: item.caption ?? input.defaultCaption,
              scheduledFor: schedule[index],
              timezone: input.timezone,
              status: "SCHEDULED",
              idempotencyKey: randomUUID(),
              assets: { create: { assetId: item.assetId, position: 0 } },
            })),
          },
        },
        include: {
          publications: {
            orderBy: { scheduledFor: "asc" },
            include: { assets: { include: { asset: { select: { id: true, filename: true } } } } },
          },
        },
      });
    },
    async manageBatch(id, action) {
      const batch = await prisma.speedPostBatch.findFirst({ where: { id, workspaceId } });
      if (!batch) throw new Error("Batch not found in the authorized workspace");
      const allowed = {
        pause: ["SCHEDULED", "RUNNING"],
        resume: ["PAUSED", "FAILED"],
        cancel: ["DRAFT", "SCHEDULED", "RUNNING", "PAUSED", "FAILED"],
      } as const;
      if (!(allowed[action] as readonly string[]).includes(batch.status)) {
        throw new Error(`Cannot ${action} a ${batch.status.toLowerCase()} batch`);
      }
      return prisma.$transaction(async (tx) => {
        const nextStatus = action === "cancel" ? "CANCELLED" : action === "pause" ? "PAUSED" : "SCHEDULED";
        const claimed = await tx.speedPostBatch.updateMany({
          where: { id, workspaceId, status: batch.status },
          data: {
            status: nextStatus,
            ...(action === "cancel" ? { cancelledAt: new Date() } : {}),
            ...(action === "pause" ? { pausedAt: new Date() } : {}),
            ...(action === "resume" ? { pausedAt: null } : {}),
          },
        });
        if (claimed.count === 0) throw new Error("Batch changed while the action was being applied");
        if (action === "cancel") {
          await tx.scheduledPublication.updateMany({
            where: { batchId: id, workspaceId, status: { in: ["DRAFT", "SCHEDULED", "QUEUED", "FAILED"] } },
            data: { status: "CANCELLED", cancelledAt: new Date() },
          });
        } else if (action === "resume") {
          await tx.scheduledPublication.updateMany({
            where: { batchId: id, workspaceId, status: "FAILED" },
            data: { status: "SCHEDULED", lastError: null, attempts: 0 },
          });
        }
        return tx.speedPostBatch.findUnique({ where: { id } });
      });
    },
  };
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

async function safeResult(operation: () => Promise<unknown>) {
  try {
    return result(await operation());
  } catch (error) {
    const known = [
      "Instagram account not found in the authorized workspace",
      "One or more media items are unavailable",
      "A Reel requires a video",
      "An image post requires a JPEG image",
      "All generated dates must be in the future",
      "Batch not found in the authorized workspace",
      "Batch changed while the action was being applied",
    ];
    const message = error instanceof Error &&
      (known.includes(error.message) || /^Cannot (pause|resume|cancel) a /.test(error.message))
      ? error.message
      : "PING CHAT could not complete this publishing operation";
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
}

export function registerPublishingTools(
  server: McpServer,
  service: McpPublishingService,
  permissions = { publishingRead: true, publishingWrite: true }
) {
  server.registerTool(
    "get_publishing_capabilities",
    { description: "Describe PING CHAT scheduling and Speed Post limits", annotations: { readOnlyHint: true } },
    async () => result({
      publicationTypes: ["IMAGE_POST", "CAROUSEL", "REEL"],
      reelModes: ["STANDARD", "TRIAL"],
      maxBatchItems: 100,
      maxPostsPerDay: 25,
      maxCarouselItems: 10,
      trialReelsRequireMetaEligibility: true,
    })
  );
  if (permissions.publishingRead) {
    server.registerTool("list_publishing_media", { description: "List ready private media in the authorized workspace", annotations: { readOnlyHint: true } }, async () => safeResult(() => service.listMedia()));
    server.registerTool("list_scheduled_publications", { description: "List scheduled, draft and historical publications", annotations: { readOnlyHint: true } }, async () => safeResult(() => service.listPublications()));
    server.registerTool("list_speed_post_batches", { description: "List Speed Post batches and progress", annotations: { readOnlyHint: true } }, async () => safeResult(() => service.listBatches()));
  }
  if (permissions.publishingWrite) server.registerTool(
    "create_scheduled_publication",
    {
      description: "Create a draft, scheduled publication, or immediate publication request. This is a write action.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: publicationInputSchema,
    },
    async (input) => safeResult(() => service.createPublication(input))
  );
  if (permissions.publishingWrite) server.registerTool(
    "create_speed_post_batch",
    {
      description: "Create and expand a Speed Post batch of up to 100 videos. This is a write action.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: createBatchSchema,
    },
    async (input) => safeResult(() => service.createBatch(input))
  );
  if (permissions.publishingWrite) server.registerTool(
    "manage_speed_post_batch",
    {
      description: "Pause, resume, or cancel a Speed Post batch. This is a write action.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({ batchId: z.string().min(1), action: batchActionSchema.shape.action }),
    },
    async ({ batchId, action }) => safeResult(() => service.manageBatch(batchId, action))
  );
}
