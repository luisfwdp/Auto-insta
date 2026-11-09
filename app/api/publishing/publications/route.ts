import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { publicationInputSchema, updatePublicationSchema } from "@/lib/publishing/schemas";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

const includePublication = {
  assets: { orderBy: { position: "asc" as const }, include: { asset: { select: { id: true, filename: true, mimeType: true, mediaType: true, status: true } } } },
  instagramAccount: { select: { id: true, username: true, name: true } },
};

async function context() {
  const value = await getCurrentWorkspaceContext();
  if (!value) return { response: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
  return { value };
}

async function validateRelations(workspaceId: string, accountId: string, assetIds: string[]) {
  const [account, assets] = await Promise.all([
    prisma.instagramAccount.findFirst({ where: { id: accountId, workspaceId }, select: { id: true } }),
    prisma.publishingAsset.findMany({ where: { id: { in: assetIds }, workspaceId, status: "READY" }, select: { id: true, mediaType: true } }),
  ]);
  return { account, assets, valid: Boolean(account) && assets.length === assetIds.length };
}

export async function GET(request: NextRequest) {
  const result = await context();
  if (result.response) return result.response;
  const workspaceId = result.value!.workspaceId;
  const accountId = request.nextUrl.searchParams.get("instagramAccountId");
  const batchId = request.nextUrl.searchParams.get("batchId");
  const from = request.nextUrl.searchParams.get("from");
  const to = request.nextUrl.searchParams.get("to");
  const publications = await prisma.scheduledPublication.findMany({
    where: {
      workspaceId,
      ...(accountId ? { instagramAccountId: accountId } : {}),
      ...(batchId ? { batchId } : {}),
      ...(from || to ? { scheduledFor: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
    take: 500,
    include: includePublication,
  });
  return NextResponse.json({ success: true, data: publications });
}

export async function POST(request: NextRequest) {
  const result = await context();
  if (result.response) return result.response;
  if (!canManageWorkspace(result.value!.role)) return NextResponse.json({ success: false, error: "Only owners and admins can create publications" }, { status: 403 });
  const parsed = publicationInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid publication", details: parsed.error.flatten() }, { status: 400 });
  const workspaceId = result.value!.workspaceId;
  const relations = await validateRelations(workspaceId, parsed.data.instagramAccountId, parsed.data.assetIds);
  if (!relations.account) return NextResponse.json({ success: false, error: "Instagram account not found" }, { status: 404 });
  if (relations.assets.length !== parsed.data.assetIds.length) return NextResponse.json({ success: false, error: "One or more media items are unavailable" }, { status: 400 });
  if (parsed.data.type === "REEL" && relations.assets[0]?.mediaType !== "VIDEO") return NextResponse.json({ success: false, error: "A Reel requires a video" }, { status: 400 });
  if (parsed.data.type === "IMAGE_POST" && relations.assets[0]?.mediaType !== "IMAGE") return NextResponse.json({ success: false, error: "An image post requires a JPEG image" }, { status: 400 });

  const scheduledFor = parsed.data.publishNow ? new Date() : parsed.data.scheduledFor ? new Date(parsed.data.scheduledFor) : null;
  const publication = await prisma.scheduledPublication.create({
    data: {
      workspaceId,
      instagramAccountId: parsed.data.instagramAccountId,
      type: parsed.data.type,
      reelMode: parsed.data.reelMode,
      caption: parsed.data.caption,
      scheduledFor,
      timezone: parsed.data.timezone,
      status: scheduledFor ? "SCHEDULED" : "DRAFT",
      idempotencyKey: randomUUID(),
      assets: { create: parsed.data.assetIds.map((assetId, position) => ({ assetId, position })) },
    },
    include: includePublication,
  });
  return NextResponse.json({ success: true, data: publication }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const result = await context();
  if (result.response) return result.response;
  if (!canManageWorkspace(result.value!.role)) return NextResponse.json({ success: false, error: "Only owners and admins can edit publications" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "Missing publication ID" }, { status: 400 });
  const parsed = updatePublicationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid publication", details: parsed.error.flatten() }, { status: 400 });
  const workspaceId = result.value!.workspaceId;
  const existing = await prisma.scheduledPublication.findFirst({ where: { id, workspaceId }, include: { assets: true } });
  if (!existing) return NextResponse.json({ success: false, error: "Publication not found" }, { status: 404 });
  if (["QUEUED", "PROCESSING", "PUBLISHED", "CANCELLED"].includes(existing.status)) return NextResponse.json({ success: false, error: "Publication can no longer be edited" }, { status: 409 });

  if (parsed.data.action === "cancel") {
    const cancelled = await prisma.$transaction(async (tx) => {
      const claimed = await tx.scheduledPublication.updateMany({
        where: { id: existing.id, workspaceId, status: { in: ["DRAFT", "SCHEDULED", "FAILED"] } },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      if (claimed.count === 0) return null;
      return tx.scheduledPublication.findUnique({ where: { id: existing.id }, include: includePublication });
    });
    if (!cancelled) return NextResponse.json({ success: false, error: "Publication was already claimed for processing" }, { status: 409 });
    return NextResponse.json({ success: true, data: cancelled });
  }

  const accountId = parsed.data.instagramAccountId ?? existing.instagramAccountId;
  const assetIds = parsed.data.assetIds ?? existing.assets.sort((a, b) => a.position - b.position).map((item) => item.assetId);
  const effective = publicationInputSchema.safeParse({
    instagramAccountId: accountId,
    type: parsed.data.type ?? existing.type,
    reelMode: parsed.data.reelMode ?? existing.reelMode,
    caption: parsed.data.caption === undefined ? existing.caption : parsed.data.caption,
    assetIds,
    scheduledFor: parsed.data.scheduledFor === undefined ? existing.scheduledFor?.toISOString() : parsed.data.scheduledFor,
    publishNow: parsed.data.action === "publish",
    timezone: parsed.data.timezone ?? existing.timezone,
  });
  if (!effective.success) return NextResponse.json({ success: false, error: "Invalid publication update", details: effective.error.flatten() }, { status: 400 });
  const relations = await validateRelations(workspaceId, accountId, assetIds);
  if (!relations.valid) return NextResponse.json({ success: false, error: "Instagram account or media is unavailable" }, { status: 400 });
  if (effective.data.type === "REEL" && relations.assets[0]?.mediaType !== "VIDEO") return NextResponse.json({ success: false, error: "A Reel requires a video" }, { status: 400 });
  if (effective.data.type === "IMAGE_POST" && relations.assets[0]?.mediaType !== "IMAGE") return NextResponse.json({ success: false, error: "An image post requires a JPEG image" }, { status: 400 });
  const scheduledFor = parsed.data.action === "publish" ? new Date() : parsed.data.scheduledFor === undefined ? existing.scheduledFor : parsed.data.scheduledFor ? new Date(parsed.data.scheduledFor) : null;
  if ((parsed.data.action === "schedule" || parsed.data.action === "reschedule") && !scheduledFor) return NextResponse.json({ success: false, error: "A scheduled date is required" }, { status: 400 });

  const publication = await prisma.$transaction(async (tx) => {
    const claimed = await tx.scheduledPublication.updateMany({
      where: { id: existing.id, workspaceId, status: existing.status },
      data: {
        instagramAccountId: parsed.data.instagramAccountId,
        type: parsed.data.type,
        reelMode: parsed.data.reelMode,
        caption: parsed.data.caption,
        scheduledFor,
        timezone: parsed.data.timezone,
        ...(parsed.data.action ? { status: "SCHEDULED" as const, cancelledAt: null, lastError: null } : {}),
      },
    });
    if (claimed.count === 0) return null;
    if (parsed.data.assetIds) {
      await tx.publicationAsset.deleteMany({ where: { publicationId: existing.id } });
      await tx.publicationAsset.createMany({ data: assetIds.map((assetId, position) => ({ publicationId: existing.id, assetId, position })) });
    }
    return tx.scheduledPublication.findUnique({ where: { id: existing.id }, include: includePublication });
  });
  if (!publication) return NextResponse.json({ success: false, error: "Publication changed while it was being edited" }, { status: 409 });
  return NextResponse.json({ success: true, data: publication });
}

export async function DELETE(request: NextRequest) {
  const clone = new NextRequest(request.url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
  return PATCH(clone);
}
