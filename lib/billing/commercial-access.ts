import type { Prisma } from "@/app/generated/prisma/client";
import { getBillingProviderScope } from "./config";
import { evaluateCommercialEntitlement, type CommercialEntitlementInput } from "./entitlements";
import { BillingError } from "./config";
import { prisma } from "@/lib/db/client";
import { isBillingEnabled } from "./trial";
import { evaluateLifetimeAccess } from "./lifetime";

/** Gates new side effects only; reads, cancellation and recovery stay usable. */
export async function assertCommercialAccess(workspaceId: string) {
  if (!isBillingEnabled()) return;
  const result = await prisma.$transaction(tx => loadCommercialEntitlement(tx, workspaceId, new Date()));
  if (!result || result.status === "denied") throw new BillingError("COMMERCIAL_ACCESS_REQUIRED", 402);
}

/** Only trusted server workspace IDs enter this loader. Never accept a subject
 * or provider binding supplied by the browser. Caller owns the transaction. */
export async function loadCommercialEntitlement(tx: Prisma.TransactionClient, workspaceId: string, now: Date) {
  await tx.$queryRaw`SELECT "workspaceId" FROM "WorkspaceBilling" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
  const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, ownerId: true } });
  if (!workspace) return null;
  const billing = await tx.workspaceBilling.findUnique({ where: { workspaceId }, include: { currentSubscription: true, lifetimeAccess: true } });
  const lifetime = evaluateLifetimeAccess(workspace, billing, now);
  if (lifetime) return lifetime;
  const trialRedemption = await tx.trialRedemption.findUnique({ where: { ownerId: workspace.ownerId } });
  const subscription = billing?.currentSubscription;
  const rows = subscription ? await tx.billingPayment.findMany({ where: { workspaceId, subscriptionId: subscription.id,
    environment: subscription.environment, accountScope: subscription.accountScope }, take: 1001 }) : [];
  // Bound local work without silently treating a truncated ledger as complete.
  if (rows.length > 1000) return null;
  let providerScope: CommercialEntitlementInput["providerScope"] = null;
  try { providerScope = getBillingProviderScope(); } catch { /* Trials do not require a payment provider. */ }
  return evaluateCommercialEntitlement({ workspace, billing, trialRedemption, currentSubscription: subscription ?? null, providerScope,
    payments: rows.map(row => ({ id: row.providerPaymentId, workspaceId: row.workspaceId, environment: row.environment,
      accountId: row.accountScope, customerId: subscription!.providerCustomerId, subscriptionId: subscription!.providerSubscriptionId,
      amountCents: row.amountCents, cycle: "MONTHLY", dueDate: row.dueDate, status: row.status as CommercialEntitlementInput["payments"][number]["status"], deleted: row.deleted })) }, now);
}

/** Read-only license projection; financial history and cancellation stay at
 * their original endpoints. Never expose the grant's actor/reason/IDs. */
export async function readLifetimeBillingStatus(workspaceId: string) {
  const row = await prisma.workspaceBilling.findUnique({ where: { workspaceId }, include: {
    lifetimeAccess: true, workspace: { select: { id: true, ownerId: true } },
  } });
  const access = row && evaluateLifetimeAccess(row.workspace, row, new Date());
  return access ? { status: "LIFETIME" as const, hasAccess: true, planId: access.planId } : null;
}
