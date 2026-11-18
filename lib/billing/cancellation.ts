import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { createAsaasClient, AsaasError } from "./asaas-client";
import { BillingError, getBillingProviderScope } from "./config";
import { claimBillingSync, assertBillingSyncLease, releaseBillingSync } from "./sync-lease";

/** Available during rollout rollback too: disabling sales must not stop cancellation. */
export async function requestSubscriptionCancellation(workspaceId: string, requestId: string) {
  if (!z.uuid().safeParse(requestId).success) throw new BillingError("INVALID_REQUEST", 400);
  const scope = getBillingProviderScope();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "workspaceId" FROM "WorkspaceBilling" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
    const previous = await tx.billingCommand.findFirst({ where: { workspaceId, requestId, subscription: scope } });
    if (previous) return { id: previous.id, status: previous.status };
    const billing = await tx.workspaceBilling.findUnique({ where: { workspaceId }, include: { currentSubscription: true } });
    const sub = billing?.currentSubscription;
    if (!sub || sub.workspaceId !== workspaceId || sub.environment !== scope.environment || sub.accountScope !== scope.accountScope) throw new BillingError("NOT_SUBSCRIBED", 404);
    const active = await tx.billingCommand.findFirst({ where: { workspaceId, subscriptionId: sub.id, status: { in: ["PENDING", "PROCESSING", "RETRY"] } } });
    const row = active ?? await tx.billingCommand.create({ data: { workspaceId, subscriptionId: sub.id, requestId } });
    return { id: row.id, status: row.status };
  });
}

export async function readCancellation(workspaceId: string, id: string) {
  if (!z.uuid().safeParse(id).success) throw new BillingError("INVALID_REQUEST", 400);
  const row = await prisma.billingCommand.findFirst({ where: { id, workspaceId, subscription: getBillingProviderScope() } });
  if (!row) throw new BillingError("NOT_FOUND", 404);
  return { id: row.id, status: row.status };
}

const eligible = (now: Date) => ({
  OR: [
    { status: { in: ["PENDING", "RETRY"] as ("PENDING" | "RETRY")[] }, nextAttemptAt: { lte: now } },
    { status: "PROCESSING" as const, leaseUntil: { lte: now } },
  ],
});

/** Durable outbox. A retry GETs canonical state before repeating idempotent DELETE. */
export async function processBillingCancellations(limit = 5, provider?: ReturnType<typeof createAsaasClient>) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new BillingError("INVALID_REQUEST", 400);
  const scope = getBillingProviderScope(), gateway = provider ?? createAsaasClient(), now = new Date();
  const candidates = await prisma.billingCommand.findMany({ where: { ...eligible(now), subscription: scope }, take: limit, orderBy: { createdAt: "asc" } });
  let processed = 0;
  for (const candidate of candidates) {
    const leaseToken = randomUUID();
    const claim = await prisma.billingCommand.updateMany({ where: { id: candidate.id, workspaceId: candidate.workspaceId, ...eligible(now) }, data: { status: "PROCESSING", leaseToken, leaseUntil: new Date(now.getTime() + 180_000), attempts: { increment: 1 } } });
    if (!claim.count) continue;
    let syncToken: string | undefined;
    try {
      syncToken = await claimBillingSync(candidate.workspaceId);
      const sub = await prisma.billingSubscription.findFirstOrThrow({ where: { id: candidate.subscriptionId, workspaceId: candidate.workspaceId, ...scope }, include: { checkout: true } });
      const canonical = await gateway.getSubscription(sub.providerSubscriptionId);
      if (canonical.customer !== sub.providerCustomerId || (canonical.checkoutSession && canonical.checkoutSession !== sub.checkout.providerCheckoutId)) throw new BillingError("CANONICAL_LINK_MISMATCH");
      let renewalStatus = canonical.deleted ? "CANCELED" : canonical.status;
      if (!canonical.deleted) {
        // The command and its processing lease already exist before this mutation.
        await gateway.cancelSubscription(sub.providerSubscriptionId);
        renewalStatus = "CANCELED";
      }
      await prisma.$transaction(async tx => {
        const billing = await assertBillingSyncLease(tx, candidate.workspaceId, syncToken!);
        const finished = await tx.billingCommand.updateMany({ where: { id: candidate.id, workspaceId: candidate.workspaceId, status: "PROCESSING", leaseToken, leaseUntil: { gt: new Date() } }, data: { status: "PROCESSED", leaseToken: null, leaseUntil: null, lastErrorCode: null } });
        if (finished.count !== 1) throw new BillingError("COMMAND_LEASE_LOST", 503);
        await tx.billingSubscription.updateMany({ where: { id: sub.id, workspaceId: sub.workspaceId, ...scope }, data: { renewalStatus } });
        if (billing.currentSubscriptionId === sub.id && billing.status !== "SUSPENDED") {
          const accessNow = new Date();
          const paid = billing.paidThrough !== null && billing.paidThrough > accessNow;
          const trial = billing.trialStartedAt <= accessNow && accessNow < billing.trialEndsAt;
          await tx.workspaceBilling.update({ where: { workspaceId: sub.workspaceId }, data: { status: !paid && trial ? "TRIALING" : "CANCELED" } });
        }
        // Preserve both original trial deadlines and paidThrough. Canceling an
        // unpaid subscription must not revoke the remainder of a card-free trial.
      });
      processed++;
    } catch (error) {
      const attempts = candidate.attempts + 1;
      const code = error instanceof AsaasError || error instanceof BillingError ? error.code : "CANCELLATION_UNAVAILABLE";
      await prisma.billingCommand.updateMany({ where: { id: candidate.id, workspaceId: candidate.workspaceId, status: "PROCESSING", leaseToken, leaseUntil: { gt: new Date() } }, data: { status: attempts >= 12 ? "DEAD" : "RETRY", leaseToken: null, leaseUntil: null, lastErrorCode: code, nextAttemptAt: new Date(Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(10, attempts - 1))) } });
    } finally {
      if (syncToken) await releaseBillingSync(candidate.workspaceId, syncToken).catch(() => {});
    }
  }
  return { processed };
}
