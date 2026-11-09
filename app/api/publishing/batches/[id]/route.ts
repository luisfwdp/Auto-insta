import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { batchActionSchema } from "@/lib/publishing/schemas";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, routeContext: RouteContext) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const { id } = await routeContext.params;
  const batch = await prisma.speedPostBatch.findFirst({
    where: { id, workspaceId: context.workspaceId },
    include: {
      instagramAccount: { select: { id: true, username: true, name: true } },
      publications: { orderBy: { scheduledFor: "asc" }, include: { assets: { orderBy: { position: "asc" }, include: { asset: { select: { id: true, filename: true, mediaType: true } } } } } },
    },
  });
  if (!batch) return NextResponse.json({ success: false, error: "Batch not found" }, { status: 404 });
  return NextResponse.json({ success: true, data: batch });
}

export async function PATCH(request: NextRequest, routeContext: RouteContext) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ success: false, error: "Only owners and admins can manage batches" }, { status: 403 });
  const parsed = batchActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid batch action" }, { status: 400 });
  const { id } = await routeContext.params;
  const batch = await prisma.speedPostBatch.findFirst({ where: { id, workspaceId: context.workspaceId } });
  if (!batch) return NextResponse.json({ success: false, error: "Batch not found" }, { status: 404 });

  const allowed = {
    pause: ["SCHEDULED", "RUNNING"],
    resume: ["PAUSED", "FAILED"],
    cancel: ["DRAFT", "SCHEDULED", "RUNNING", "PAUSED", "FAILED"],
  } as const;
  if (!(allowed[parsed.data.action] as readonly string[]).includes(batch.status)) return NextResponse.json({ success: false, error: `Cannot ${parsed.data.action} a ${batch.status.toLowerCase()} batch` }, { status: 409 });

  const updated = await prisma.$transaction(async (tx) => {
    const nextStatus = parsed.data.action === "cancel" ? "CANCELLED" : parsed.data.action === "pause" ? "PAUSED" : "SCHEDULED";
    const claimed = await tx.speedPostBatch.updateMany({
      where: { id: batch.id, workspaceId: context.workspaceId, status: batch.status },
      data: {
        status: nextStatus,
        ...(parsed.data.action === "cancel" ? { cancelledAt: new Date() } : {}),
        ...(parsed.data.action === "pause" ? { pausedAt: new Date() } : {}),
        ...(parsed.data.action === "resume" ? { pausedAt: null } : {}),
      },
    });
    if (claimed.count === 0) return null;
    if (parsed.data.action === "cancel") {
      await tx.scheduledPublication.updateMany({
        where: { batchId: batch.id, workspaceId: context.workspaceId, status: { in: ["DRAFT", "SCHEDULED", "QUEUED", "FAILED"] } },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
    } else if (parsed.data.action === "resume") {
      await tx.scheduledPublication.updateMany({
        where: { batchId: batch.id, workspaceId: context.workspaceId, status: "FAILED" },
        data: { status: "SCHEDULED", lastError: null, attempts: 0 },
      });
    }
    return tx.speedPostBatch.findUnique({ where: { id: batch.id } });
  });
  if (!updated) return NextResponse.json({ success: false, error: "Batch changed while the action was being applied" }, { status: 409 });
  return NextResponse.json({ success: true, data: updated });
}

export async function DELETE(request: NextRequest, routeContext: RouteContext) {
  const clone = new NextRequest(request.url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
  return PATCH(clone, routeContext);
}
