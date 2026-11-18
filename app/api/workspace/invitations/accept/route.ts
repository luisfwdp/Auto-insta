import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { normalizeInvitationEmail } from "@/lib/workspace-invitations";
import { assertCommercialMemberCapacity } from "@/lib/billing/commercial-capacity";
import { BillingError } from "@/lib/billing/config";
import { isBillingEnabled } from "@/lib/billing/trial";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json(
      { success: false, error: "Sign in with the invited email first" },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const token = typeof body.token === "string" ? body.token : null;
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Missing invitation token" },
      { status: 400 }
    );
  }

  const invitation = await prisma.workspaceInvitation.findUnique({
    where: { token },
    include: { workspace: { select: { name: true } } },
  });
  if (!invitation || invitation.status !== "PENDING") {
    return NextResponse.json(
      { success: false, error: "Invitation is no longer available" },
      { status: 404 }
    );
  }

  if (invitation.expiresAt <= new Date()) {
    await prisma.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    return NextResponse.json(
      { success: false, error: "Invitation has expired" },
      { status: 410 }
    );
  }

  if (normalizeInvitationEmail(session.user.email) !== (isBillingEnabled() ? normalizeInvitationEmail(invitation.email) : invitation.email)) {
    return NextResponse.json(
      { success: false, error: "This invitation is for a different email" },
      { status: 403 }
    );
  }

  let accepted = false;
  try { accepted = await prisma.$transaction(async (tx) => {
    await assertCommercialMemberCapacity(tx, invitation.workspaceId, { userId: session.user.id, email: normalizeInvitationEmail(session.user.email!) });
    // Atomically consume a still-valid invitation before creating membership.
    // A revoked, expired or concurrently accepted invitation grants nothing.
    const consumed = await tx.workspaceInvitation.updateMany({
      where: {
        id: invitation.id,
        workspaceId: invitation.workspaceId,
        token,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    });
    if (consumed.count !== 1) return false;

    await tx.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: invitation.workspaceId,
          userId: session.user.id,
        },
      },
      create: {
        workspaceId: invitation.workspaceId,
        userId: session.user.id,
        role: invitation.role,
      },
      // Stale invitations must not overwrite a member's current role.
      update: {},
    });
    // Explicitly accepting an invitation selects its workspace, without losing
    // the user's older memberships. Every resolver rechecks current membership.
    if (isBillingEnabled()) await tx.user.update({
      where: { id: session.user.id }, data: { activeWorkspaceId: invitation.workspaceId },
    });
    return true;
  }); } catch (error) {
    if (error instanceof BillingError) return NextResponse.json({ success: false, error: error.code }, { status: error.httpStatus, headers: { "Cache-Control": "no-store" } });
    throw error;
  }

  if (!accepted) {
    return NextResponse.json(
      { success: false, error: "Invitation is no longer available" },
      { status: 409 }
    );
  }

  return NextResponse.json({
    success: true,
    data: {
      workspaceName: invitation.workspace.name,
    },
  });
}

