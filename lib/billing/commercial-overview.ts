import { prisma } from "@/lib/db/client";
import { loadCommercialEntitlement } from "./commercial-access";
import { BillingError, getBillingProviderScope } from "./config";
import { isBillingEnabled } from "./trial";

function safeCounter(value: bigint): number {
  if (value < BigInt("0") || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new BillingError("BILLING_UNAVAILABLE", 503);
  return Number(value);
}

/** Read only projection of the trusted financial entitlement and its exact
 * allocation period. No legacy counters, provider calls, receipts or IDs. */
export async function readCommercialOverview(workspaceId: string) {
  if (!isBillingEnabled()) throw new BillingError("BILLING_DISABLED", 404);
  return prisma.$transaction(async tx => {
    const access = await loadCommercialEntitlement(tx, workspaceId, new Date());
    if (!access || access.status === "denied") return { hasAccess: false as const, code: access?.code ?? "BILLING_NOT_STARTED", limits: null, counters: null };
    const scopeKey = access.subjectKind === "OWNER_TRIAL" ? "owner-trial-v1" : (() => {
      const scope = getBillingProviderScope(); return `${scope.environment}:${scope.accountScope}`;
    })();
    const buckets = await tx.commercialUsageBucket.findMany({ where: { subjectKind: access.subjectKind, subjectId: access.subjectId,
      scopeKey, periodStart: access.periodStart, periodEnd: access.periodEnd, resource: { in: ["DM", "PUBLICATION"] } },
      select: { resource: true, consumed: true, reserved: true } });
    const counter = (resource: "DM" | "PUBLICATION", limit: number) => {
      const row = buckets.find(bucket => bucket.resource === resource);
      return { consumed: safeCounter(row?.consumed ?? BigInt("0")), reserved: safeCounter(row?.reserved ?? BigInt("0")), limit };
    };
    const limits = access.limits;
    return { hasAccess: true as const, kind: access.status, periodStart: access.periodStart.toISOString(), periodEnd: access.periodEnd.toISOString(),
      limits: { accounts: limits.accounts, members: limits.members, dms: limits.dms, publications: limits.publications, storageBytes: limits.storageBytes, transferBytes: limits.transferBytes },
      counters: { dms: counter("DM", limits.dms), publications: counter("PUBLICATION", limits.publications), storage: null, transfer: null },
      metering: { storage: "NOT_REPORTED" as const, transfer: "NOT_METERED" as const } };
  });
}
