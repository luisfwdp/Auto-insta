import { prisma } from "@/lib/db/client";
import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";
import { assertCommercialMemberCapacity } from "@/lib/billing/commercial-capacity";
import { BillingError } from "@/lib/billing/config";
import { isBillingEnabled } from "@/lib/billing/trial";
import { getSelectedWorkspaceMembership } from "@/lib/workspace-selection";

function normalizeInviteEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function acceptPendingInvitationsForUser(
  userId: string,
  email?: string | null
): Promise<void> {
  if (!email) return;

  const normalizedEmail = normalizeInviteEmail(email);
  const now = new Date();
  const invitations = await prisma.workspaceInvitation.findMany({
    where: {
      email: isBillingEnabled() ? { equals: normalizedEmail, mode: "insensitive" } : normalizedEmail,
      status: "PENDING",
      expiresAt: { gt: now },
    },
  });

  for (const invitation of invitations) {
    try { await prisma.$transaction(async (tx) => {
      await assertCommercialMemberCapacity(tx, invitation.workspaceId, { userId, email: normalizedEmail });
      const acceptedAt = new Date();
      // A pending snapshot can be revoked, expire or be replaced before this
      // transaction. Claim exactly that invitation before granting membership.
      const consumed = await tx.workspaceInvitation.updateMany({
        where: {
          id: invitation.id,
          workspaceId: invitation.workspaceId,
          email: isBillingEnabled() ? invitation.email : normalizedEmail,
          token: invitation.token,
          role: invitation.role,
          status: "PENDING",
          expiresAt: { gt: acceptedAt },
        },
        data: { status: "ACCEPTED", acceptedAt },
      });
      if (consumed.count !== 1) return;

      await tx.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: invitation.workspaceId,
            userId,
          },
        },
        create: {
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role,
        },
        // Invitation acceptance cannot overwrite later membership authority.
        update: {},
      });
    }); } catch (error) {
      // A full/expired invited workspace must not prevent the user signing in
      // to an existing workspace, or creating their own. Leave the invite pending.
      if (!(error instanceof BillingError)) throw error;
    }
  }
}

export async function getWorkspaceMembership(userId: string): Promise<{
  workspace: Workspace;
  role: WorkspaceRole;
} | null> {
  const membership = await getSelectedWorkspaceMembership(userId);

  if (!membership) return null;

  return {
    workspace: membership.workspace,
    role: membership.role,
  };
}

export async function ensureWorkspaceForUser(
  userId: string,
  email?: string | null
): Promise<Workspace> {
  await acceptPendingInvitationsForUser(userId, email);

  const existingMembership = await getWorkspaceMembership(userId);
  if (existingMembership) {
    return existingMembership.workspace;
  }

  const workspaceName = email ? `${email.split("@")[0]}'s workspace` : "My workspace";

  return prisma.workspace.create({
    data: {
      name: workspaceName,
      ownerId: userId,
      members: {
        create: {
          userId,
          role: "OWNER",
        },
      },
    },
  });
}

export async function getPrimaryWorkspace(userId: string): Promise<Workspace | null> {
  const membership = await getWorkspaceMembership(userId);
  return membership?.workspace ?? null;
}
