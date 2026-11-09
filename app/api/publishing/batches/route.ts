import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { createBatchSchema } from "@/lib/publishing/schemas";
import { generateBatchSchedule, orderBatchItems } from "@/lib/publishing/schedule";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const accountId = request.nextUrl.searchParams.get("instagramAccountId");
  const batches = await prisma.speedPostBatch.findMany({
    where: { workspaceId: context.workspaceId, ...(accountId ? { instagramAccountId: accountId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { instagramAccount: { select: { id: true, username: true, name: true } } },
  });
  return NextResponse.json({ success: true, data: batches });
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ success: false, error: "Only owners and admins can create batches" }, { status: 403 });
  const parsed = createBatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid batch", details: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;
  const assetIds = input.items.map((item) => item.assetId);
  const [account, assets] = await Promise.all([
    prisma.instagramAccount.findFirst({ where: { id: input.instagramAccountId, workspaceId: context.workspaceId }, select: { id: true } }),
    prisma.publishingAsset.findMany({ where: { id: { in: assetIds }, workspaceId: context.workspaceId, status: "READY", mediaType: "VIDEO" }, select: { id: true, filename: true } }),
  ]);
  if (!account) return NextResponse.json({ success: false, error: "Instagram account not found" }, { status: 404 });
  if (assets.length !== assetIds.length) return NextResponse.json({ success: false, error: "Every Speed Post item must be an available video" }, { status: 400 });

  const randomSeed = input.orderMode === "RANDOM" ? randomUUID() : null;
  const filenames = new Map(assets.map((asset) => [asset.id, asset.filename]));
  const ordered = orderBatchItems(input.items, input.orderMode, randomSeed ?? "sequential", filenames);
  let schedule: Date[];
  try {
    schedule = input.scheduleMode === "CUSTOM"
      ? ordered.map((item) => new Date(item.scheduledFor!))
      : generateBatchSchedule(input, ordered.length);
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Invalid schedule" }, { status: 400 });
  }
  if (schedule.some((date) => date.getTime() <= Date.now())) return NextResponse.json({ success: false, error: "All generated dates must be in the future" }, { status: 400 });

  const batch = await prisma.speedPostBatch.create({
    data: {
      workspaceId: context.workspaceId,
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
          workspaceId: context.workspaceId,
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
      publications: { orderBy: { scheduledFor: "asc" }, include: { assets: { include: { asset: { select: { id: true, filename: true } } } } } },
    },
  });
  return NextResponse.json({ success: true, data: batch }, { status: 201 });
}
