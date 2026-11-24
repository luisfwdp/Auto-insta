import { prisma } from "@/lib/db/client";
import { loadCommercialEntitlement } from "./commercial-access";
import { BillingError } from "./config";
import { isBillingEnabled } from "./trial";
import { commercialScopeKey } from "./lifetime";

function safeCounter(value: bigint): number {
  if (value < BigInt("0") || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new BillingError("BILLING_UNAVAILABLE", 503);
  return Number(value);
}

/** Read only projection of the trusted financial entitlement and its exact
 * allocation period. Owner-trial usage is shared across workspaces and is
 * visible only to the actual owner, regardless of the viewer's workspace role.
 * No legacy counters, provider calls, receipts or IDs. */
export async function readCommercialUsageOverview(workspaceId: string, viewerUserId: string) {
  if (!isBillingEnabled()) throw new BillingError("BILLING_DISABLED", 404);
  return prisma.$transaction(async tx => {
    const access = await loadCommercialEntitlement(tx, workspaceId, new Date());
    if (!access || access.status === "denied") return { hasAccess: false as const, code: access?.code ?? "BILLING_NOT_STARTED", limits: null, counters: null };
    const limits = access.limits;
    const view = { hasAccess: true as const, kind: access.status, periodStart: access.periodStart.toISOString(), periodEnd: access.periodEnd.toISOString(),
      limits: { accounts: limits.accounts, members: limits.members, dms: limits.dms, publications: limits.publications, storageBytes: limits.storageBytes, transferBytes: limits.transferBytes },
      metering: { storage: "NOT_REPORTED" as const, transfer: "NOT_METERED" as const } };
    if (access.subjectKind === "OWNER_TRIAL" && viewerUserId !== access.subjectId)
      return { ...view, counters: null, usageVisibility: "OWNER_ONLY" as const };
    const scopeKey = commercialScopeKey(access);
    const buckets = await tx.commercialUsageBucket.findMany({ where: { subjectKind: access.subjectKind, subjectId: access.subjectId,
      scopeKey, periodStart: access.periodStart, periodEnd: access.periodEnd, resource: { in: ["DM", "PUBLICATION"] } },
      select: { resource: true, consumed: true, reserved: true } });
    const counter = (resource: "DM" | "PUBLICATION", limit: number) => {
      const row = buckets.find(bucket => bucket.resource === resource);
      return { consumed: safeCounter(row?.consumed ?? BigInt("0")), reserved: safeCounter(row?.reserved ?? BigInt("0")), limit };
    };
    return { ...view, usageVisibility: "AVAILABLE" as const,
      counters: { dms: counter("DM", limits.dms), publications: counter("PUBLICATION", limits.publications), storage: null, transfer: null },
    };
  });
}
