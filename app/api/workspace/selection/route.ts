import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { isTrustedBrowserOrigin } from "@/lib/api/origin";
import { readBillingJson } from "@/lib/billing/http";
import { BillingError } from "@/lib/billing/config";
import { isBillingEnabled } from "@/lib/billing/trial";
import { getSelectedWorkspaceMembership } from "@/lib/workspace-selection";

const selection = z.object({ workspaceId: z.string().min(1).max(200) }).strict();
const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown) {
  const known = error instanceof BillingError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    && Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599;
  return NextResponse.json({ success: false, error: known ? error.code : "WORKSPACE_SELECTION_UNAVAILABLE" },
    { status: known ? error.httpStatus : 503, headers });
}

/** Membership selection is available even when a trial/subscription expired. */
export async function GET() {
  if (!isBillingEnabled()) return failure(new BillingError("NOT_FOUND", 404));
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new BillingError("UNAUTHORIZED", 401);
    const [active, memberships] = await Promise.all([
      getSelectedWorkspaceMembership(userId),
      prisma.workspaceMember.findMany({ where: { userId }, orderBy: { createdAt: "asc" },
        select: { role: true, workspace: { select: { id: true, name: true } } } }),
    ]);
    return NextResponse.json({ success: true, data: {
      activeWorkspaceId: active?.workspaceId ?? null, activeWorkspaceName: active?.workspace.name ?? null,
      workspaces: memberships.map(member => ({ id: member.workspace.id, name: member.workspace.name, role: member.role })),
    } }, { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  if (!isBillingEnabled()) return failure(new BillingError("NOT_FOUND", 404));
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new BillingError("UNAUTHORIZED", 401);
    if (!request.headers.get("origin") || !isTrustedBrowserOrigin(request)) throw new BillingError("FORBIDDEN", 403);
    const parsed = selection.safeParse(await readBillingJson(request));
    if (!parsed.success) throw new BillingError("INVALID_REQUEST", 400);
    const selected = await prisma.$transaction(async tx => {
      const member = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: parsed.data.workspaceId, userId } },
        select: { role: true, workspace: { select: { id: true, name: true } } },
      });
      if (!member) throw new BillingError("NOT_FOUND", 404);
      await tx.user.update({ where: { id: userId }, data: { activeWorkspaceId: member.workspace.id }, select: { id: true } });
      return { id: member.workspace.id, name: member.workspace.name, role: member.role };
    });
    return NextResponse.json({ success: true, data: selected }, { headers });
  } catch (error) { return failure(error); }
}
