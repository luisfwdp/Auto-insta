import { prisma } from "@/lib/db/client";
import { isBillingEnabled } from "@/lib/billing/trial";

/** Trusted authenticated user ID only. A preference never grants membership.
 * Legacy mode deliberately does not select the additive activeWorkspaceId
 * column, preserving this resolver's original query shape. */
export async function getSelectedWorkspaceMembership(userId: string) {
  if (isBillingEnabled()) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { activeWorkspaceId: true } });
    if (user?.activeWorkspaceId) {
      const selected = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: user.activeWorkspaceId, userId } },
        include: { workspace: true },
      });
      if (selected) return selected;
    }
  }
  return prisma.workspaceMember.findFirst({
    where: { userId }, include: { workspace: true }, orderBy: { createdAt: "asc" },
  });
}
