import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { CommercialUsageResource, Prisma } from "@/app/generated/prisma/client";
import { BillingError, getBillingProviderScope } from "./config";
import { loadCommercialEntitlement } from "./commercial-access";
import { isBillingEnabled } from "./trial";

const operation = z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/);
const resources = new Set<CommercialUsageResource>(["DM", "PUBLICATION", "STORAGE_BYTES", "TRANSFER_BYTES"]);
const limitKey = { DM: "dms", PUBLICATION: "publications", STORAGE_BYTES: "storageBytes", TRANSFER_BYTES: "transferBytes" } as const;
type Tx = Prisma.TransactionClient;

async function entitlement(tx: Tx, workspaceId: string) {
  const result = await loadCommercialEntitlement(tx, workspaceId, new Date());
  if (!result || result.status === "denied" || !result.limits || !result.subjectKind || !result.subjectId || !result.periodStart || !result.periodEnd)
    throw new BillingError("COMMERCIAL_ACCESS_REQUIRED", 402);
  return result;
}

/** Internal server API: workspace and operation identities must be established
 * by authenticated routes or persisted jobs. No browser-provided subject IDs.
 * Existing operations remain bound to their original period across retries. */
export async function reserveCommercialUsage(workspaceId: string, resource: CommercialUsageResource, operationKey: string, amount = 1) {
  if (!resources.has(resource) || !operation.safeParse(operationKey).success || !Number.isSafeInteger(amount) || amount <= 0)
    throw new BillingError("INVALID_USAGE_RESERVATION", 400);
  if (!isBillingEnabled()) return { mode: "legacy" as const, reservationId: null, status: null };
  // Storage needs an authoritative baseline of retained assets when a trial
  // becomes paid. This primitive cannot safely infer that from usage events.
  if (resource === "STORAGE_BYTES") throw new BillingError("STORAGE_ENFORCEMENT_NOT_READY", 503);
  return prisma.$transaction(async tx => {
    const access = await entitlement(tx, workspaceId);
    const previous = await tx.commercialUsageReservation.findUnique({ where: { workspaceId_resource_operationKey: { workspaceId, resource, operationKey } } });
    if (previous) {
      if (previous.amount !== BigInt(amount)) throw new BillingError("USAGE_OPERATION_CONFLICT");
      return { mode: "commercial" as const, reservationId: previous.id, status: previous.status };
    }
    const scopeKey = access.subjectKind === "OWNER_TRIAL" ? "owner-trial-v1" : (() => {
      const scope = getBillingProviderScope(); return `${scope.environment}:${scope.accountScope}`;
    })();
    const periodStart = access.periodStart;
    const periodEnd = access.periodEnd;
    const cap = BigInt(access.limits[limitKey[resource]]);
    // An empty-update Prisma upsert may race as SELECT + INSERT. Native INSERT
    // ON CONFLICT via createMany preserves legitimate first-use requests from
    // different workspaces sharing the same owner's trial bucket.
    await tx.commercialUsageBucket.createMany({ data: [{ subjectKind: access.subjectKind, subjectId: access.subjectId,
      scopeKey, resource, periodStart, periodEnd, limitSnapshot: cap }], skipDuplicates: true });
    const bucket = await tx.commercialUsageBucket.findUniqueOrThrow({ where: { subjectKind_subjectId_scopeKey_resource_periodStart: {
      subjectKind: access.subjectKind, subjectId: access.subjectId, scopeKey, resource, periodStart } } });
    await tx.$queryRaw`SELECT "id" FROM "CommercialUsageBucket" WHERE "id" = ${bucket.id}::uuid FOR UPDATE`;
    const current = await tx.commercialUsageBucket.findUniqueOrThrow({ where: { id: bucket.id } });
    if (current.periodEnd.getTime() !== periodEnd.getTime()) throw new BillingError("USAGE_PERIOD_CONFLICT");
    if (current.consumed + current.reserved + BigInt(amount) > cap) throw new BillingError("COMMERCIAL_QUOTA_EXCEEDED", 402);
    await tx.commercialUsageBucket.update({ where: { id: current.id }, data: { reserved: { increment: BigInt(amount) } } });
    const row = await tx.commercialUsageReservation.create({ data: { workspaceId, bucketId: current.id, resource, operationKey, amount: BigInt(amount) } });
    return { mode: "commercial" as const, reservationId: row.id, status: row.status };
  });
}

/** Single dispatch claim immediately before an external side effect. No timeout
 * resets DISPATCHING: an unknown provider outcome must be recovered explicitly. */
export async function beginCommercialDispatch(workspaceId: string, reservationId: string) {
  if (!z.uuid().safeParse(reservationId).success) throw new BillingError("INVALID_USAGE_RESERVATION", 400);
  return prisma.$transaction(async tx => {
    // Revalidate even when the operation was queued during an active trial.
    const access = await entitlement(tx, workspaceId);
    const row = await tx.commercialUsageReservation.findFirst({ where: { id: reservationId, workspaceId }, include: { bucket: true } });
    if (!row || row.status !== "RESERVED") return null;
    const scopeKey = access.subjectKind === "OWNER_TRIAL" ? "owner-trial-v1" : (() => {
      const scope = getBillingProviderScope(); return `${scope.environment}:${scope.accountScope}`;
    })();
    const bucket = row.bucket;
    if (bucket.resource !== row.resource || bucket.subjectKind !== access.subjectKind || bucket.subjectId !== access.subjectId || bucket.scopeKey !== scopeKey
      || bucket.periodStart.getTime() !== access.periodStart.getTime() || bucket.periodEnd.getTime() !== access.periodEnd.getTime())
      throw new BillingError("USAGE_RESERVATION_STALE");
    if (bucket.consumed + bucket.reserved > BigInt(access.limits[limitKey[row.resource]]))
      throw new BillingError("COMMERCIAL_QUOTA_EXCEEDED", 402);
    const token = randomUUID();
    const claim = await tx.commercialUsageReservation.updateMany({ where: { id: reservationId, workspaceId, status: "RESERVED" },
      data: { status: "DISPATCHING", dispatchToken: token } });
    return claim.count === 1 ? { dispatchToken: token } : null;
  });
}

/** Call only with authoritative provider proof. UNKNOWN keeps the reservation
 * held and cannot dispatch again. A confirmed rejection permits a safe retry.
 * Finalizing already-made effects remains available after trial expiry. */
export async function finishCommercialDispatch(workspaceId: string, reservationId: string, dispatchToken: string,
  outcome: "CONFIRMED" | "DEFINITELY_REJECTED" | "UNKNOWN") {
  if (!z.uuid().safeParse(reservationId).success || !z.uuid().safeParse(dispatchToken).success || !["CONFIRMED", "DEFINITELY_REJECTED", "UNKNOWN"].includes(outcome))
    throw new BillingError("INVALID_USAGE_RESERVATION", 400);
  if (outcome === "UNKNOWN") return false;
  return prisma.$transaction(async tx => {
    const row = await tx.commercialUsageReservation.findFirst({ where: { id: reservationId, workspaceId, status: "DISPATCHING", dispatchToken } });
    if (!row) return false;
    const claim = await tx.commercialUsageReservation.updateMany({ where: { id: row.id, workspaceId, status: "DISPATCHING", dispatchToken },
      data: outcome === "CONFIRMED" ? { status: "COMMITTED" } : { status: "RESERVED", dispatchToken: null } });
    if (claim.count !== 1) return false;
    if (outcome === "CONFIRMED") await tx.commercialUsageBucket.update({ where: { id: row.bucketId }, data: {
      reserved: { decrement: row.amount }, consumed: { increment: row.amount } } });
    return true;
  });
}

/** Release is safe before dispatch only. Never free unknown/confirmed sends.
 * There is deliberately no blanket expiry job or auto-reset for reservations. */
export async function releaseCommercialUsage(workspaceId: string, reservationId: string) {
  if (!z.uuid().safeParse(reservationId).success) throw new BillingError("INVALID_USAGE_RESERVATION", 400);
  return prisma.$transaction(async tx => {
    const row = await tx.commercialUsageReservation.findFirst({ where: { id: reservationId, workspaceId, status: "RESERVED" } });
    if (!row) return false;
    const claim = await tx.commercialUsageReservation.updateMany({ where: { id: row.id, workspaceId, status: "RESERVED" }, data: { status: "RELEASED" } });
    if (claim.count !== 1) return false;
    await tx.commercialUsageBucket.update({ where: { id: row.bucketId }, data: { reserved: { decrement: row.amount } } });
    return true;
  });
}
