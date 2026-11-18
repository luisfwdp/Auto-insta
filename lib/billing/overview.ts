import { prisma } from "@/lib/db/client";
import { billingStatusDTO } from "./trial";
import { getBillingProviderScope } from "./config";

/** Sales can be disabled without hiding an existing owner's cancellation path. */
export async function readBillingOverview(workspaceId: string) {
  const scope = getBillingProviderScope();
  const row = await prisma.workspaceBilling.findUnique({ where: { workspaceId }, include: {
    currentSubscription: { select: { id: true, workspaceId: true, environment: true, accountScope: true, renewalStatus: true } },
  } });
  const sub = row?.currentSubscription;
  const owned = sub?.workspaceId === workspaceId && sub.environment === scope.environment && sub.accountScope === scope.accountScope;
  const pending = owned && await prisma.billingCommand.count({ where: { workspaceId, subscriptionId: sub.id, status: { in: ["PENDING", "PROCESSING", "RETRY"] } } });
  const dto = billingStatusDTO(row);
  const invalidPaidBinding = dto.hasAccess && row?.status !== "TRIALING" && !owned;
  return { ...dto, ...(invalidPaidBinding ? { status: "REVIEW_REQUIRED", hasAccess: false } : {}),
    canCancelRenewal: Boolean(owned && sub.renewalStatus !== "CANCELED"), cancellationPending: Boolean(pending) };
}
