import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { CommercialUsageResource, Prisma } from "@/app/generated/prisma/client";
import { BillingError, getBillingProviderScope } from "./config";
import { loadCommercialEntitlement } from "./commercial-access";
import { isBillingEnabled } from "./trial";
import { encryptToken, decryptToken } from "@/lib/meta/oauth";

const operation = z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/);
const resources = new Set<CommercialUsageResource>(["DM", "PUBLICATION", "STORAGE_BYTES", "TRANSFER_BYTES"]);
const limitKey = { DM: "dms", PUBLICATION: "publications", STORAGE_BYTES: "storageBytes", TRANSFER_BYTES: "transferBytes" } as const;
type Tx = Prisma.TransactionClient;
const receiptSchema = z.object({ messageId: z.string().regex(/^[!-~]{1,2048}$/), recipientId: z.string().regex(/^[!-~]{1,2048}$/).optional() }).strict();
export type CommercialMessageReceipt = z.infer<typeof receiptSchema>;

/** IDs only, encrypted at rest; no raw provider payload or message text. A real
 * receipt makes an idempotent replay possible without inventing delivery IDs. */
export async function readCommercialUsageReceipt(workspaceId: string, reservationId: string): Promise<CommercialMessageReceipt | null> {
  if (!z.uuid().safeParse(reservationId).success) throw new BillingError("INVALID_USAGE_RESERVATION", 400);
  const row = await prisma.commercialUsageReservation.findFirst({ where: { id: reservationId, workspaceId, resource: "DM", status: "COMMITTED" }, select: { receiptCiphertext: true } });
  if (!row?.receiptCiphertext) return null;
  try { return receiptSchema.parse(JSON.parse(decryptToken(row.receiptCiphertext))); }
  catch { throw new BillingError("USAGE_RECEIPT_UNAVAILABLE", 503); }
}

async function entitlement(tx: Tx, workspaceId: string) {
  const result = await loadCommercialEntitlement(tx, workspaceId, new Date());
  if (!result || result.status === "denied" || !result.limits || !result.subjectKind || !result.subjectId || !result.periodStart || !result.periodEnd)
    throw new BillingError("COMMERCIAL_ACCESS_REQUIRED", 402);
  return result;
}

function validateOperation(resource: CommercialUsageResource, operationKey: string, amount: number, intentFingerprint?: string) {
  if (!resources.has(resource) || !operation.safeParse(operationKey).success || !Number.isSafeInteger(amount) || amount <= 0)
    throw new BillingError("INVALID_USAGE_RESERVATION", 400);
  if (intentFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(intentFingerprint)) throw new BillingError("INVALID_USAGE_RESERVATION", 400);
}

/** Read existing immutable intent without allocating quota or requiring current
 * access. Terminal receipt replay must remain possible after expiry/downgrade. */
export async function findCommercialUsageOperation(workspaceId: string, resource: CommercialUsageResource, operationKey: string, amount = 1, intentFingerprint?: string) {
  validateOperation(resource, operationKey, amount, intentFingerprint);
  if (!isBillingEnabled()) return null;
  const row = await prisma.commercialUsageReservation.findUnique({ where: { workspaceId_resource_operationKey: { workspaceId, resource, operationKey } },
    select: { id: true, status: true, amount: true, intentFingerprint: true } });
  if (!row) return null;
  if (row.amount !== BigInt(amount) || row.intentFingerprint !== (intentFingerprint ?? null)) throw new BillingError("USAGE_OPERATION_CONFLICT");
  return { reservationId: row.id, status: row.status };
}

/** Internal server API: workspace and operation identities must be established
 * by authenticated routes or persisted jobs. No browser-provided subject IDs.
 * Unknown/confirmed operations retain their original allocation. Only a proven
 * rejection may reserve again in a new period; a cancellation stays terminal. */
export async function reserveCommercialUsage(workspaceId: string, resource: CommercialUsageResource, operationKey: string, amount = 1, intentFingerprint?: string) {
  validateOperation(resource, operationKey, amount, intentFingerprint);
  if (!isBillingEnabled()) return { mode: "legacy" as const, reservationId: null, status: null };
  // Storage needs an authoritative baseline of retained assets when a trial
  // becomes paid. This primitive cannot safely infer that from usage events.
  if (resource === "STORAGE_BYTES") throw new BillingError("STORAGE_ENFORCEMENT_NOT_READY", 503);
  return prisma.$transaction(async tx => {
    const previous = await tx.commercialUsageReservation.findUnique({ where: { workspaceId_resource_operationKey: { workspaceId, resource, operationKey } } });
    if (previous) {
      if (previous.amount !== BigInt(amount) || previous.intentFingerprint !== (intentFingerprint ?? null)) throw new BillingError("USAGE_OPERATION_CONFLICT");
      if (!["RESERVED", "REJECTED"].includes(previous.status)) return { mode: "commercial" as const, reservationId: previous.id, status: previous.status };
    }
    const access = await entitlement(tx, workspaceId);
    // The access loader serializes this workspace. A concurrent first request
    // may have inserted the operation while we waited for that lock.
    const lockedPrevious = await tx.commercialUsageReservation.findUnique({ where: { workspaceId_resource_operationKey: { workspaceId, resource, operationKey } } });
    if (lockedPrevious) {
      if (lockedPrevious.amount !== BigInt(amount) || lockedPrevious.intentFingerprint !== (intentFingerprint ?? null)) throw new BillingError("USAGE_OPERATION_CONFLICT");
      if (lockedPrevious.status !== "REJECTED") return { mode: "commercial" as const, reservationId: lockedPrevious.id, status: lockedPrevious.status };
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
    const row = lockedPrevious ? await tx.commercialUsageReservation.update({ where: { id: lockedPrevious.id, workspaceId }, data: {
      bucketId: current.id, status: "RESERVED", dispatchToken: null } }) :
      await tx.commercialUsageReservation.create({ data: { workspaceId, bucketId: current.id, resource, operationKey, amount: BigInt(amount), intentFingerprint } });
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

/** Call only with authoritative proof of the external outcome. UNKNOWN keeps
 * the reservation held. A proven rejection frees cost and permits reserve again.
 * Finalizing already-made effects remains available after trial expiry. */
export async function finishCommercialDispatch(workspaceId: string, reservationId: string, dispatchToken: string,
  outcome: "CONFIRMED" | "DEFINITELY_REJECTED" | "UNKNOWN", receipt?: CommercialMessageReceipt) {
  if (!z.uuid().safeParse(reservationId).success || !z.uuid().safeParse(dispatchToken).success || !["CONFIRMED", "DEFINITELY_REJECTED", "UNKNOWN"].includes(outcome))
    throw new BillingError("INVALID_USAGE_RESERVATION", 400);
  if (outcome === "UNKNOWN") return false;
  let receiptCiphertext: string | undefined;
  if (receipt !== undefined) {
    if (outcome !== "CONFIRMED") throw new BillingError("INVALID_USAGE_RECEIPT", 400);
    const parsed = receiptSchema.safeParse(receipt);
    if (!parsed.success) throw new BillingError("INVALID_USAGE_RECEIPT", 400);
    receiptCiphertext = encryptToken(JSON.stringify(parsed.data));
  }
  return prisma.$transaction(async tx => {
    const row = await tx.commercialUsageReservation.findFirst({ where: { id: reservationId, workspaceId, status: "DISPATCHING", dispatchToken } });
    if (!row) return false;
    if (receiptCiphertext !== undefined && row.resource !== "DM") throw new BillingError("INVALID_USAGE_RECEIPT", 400);
    const claim = await tx.commercialUsageReservation.updateMany({ where: { id: row.id, workspaceId, status: "DISPATCHING", dispatchToken },
      data: outcome === "CONFIRMED" ? { status: "COMMITTED", ...(receiptCiphertext !== undefined ? { receiptCiphertext } : {}) } : { status: "REJECTED", dispatchToken: null } });
    if (claim.count !== 1) return false;
    await tx.commercialUsageBucket.update({ where: { id: row.bucketId }, data: {
      reserved: { decrement: row.amount }, ...(outcome === "CONFIRMED" ? { consumed: { increment: row.amount } } : {}) } });
    return true;
  });
}

/** Recovery only after the worker receives canonical Meta PUBLISHED proof.
 * Bind the proof to the persisted tenant/container/operation. Already completed
 * publications without a commercial reservation remain recoverable unchanged. */
export async function recoverCommercialPublication(workspaceId: string, operationKey: string, containerId: string, mediaId?: string) {
  if (!isBillingEnabled()) return false;
  if (!operation.safeParse(operationKey).success || !containerId || !/^[!-~]{1,2048}$/.test(containerId)
    || (mediaId !== undefined && !/^[!-~]{1,2048}$/.test(mediaId))) throw new BillingError("INVALID_USAGE_RECEIPT", 400);
  return prisma.$transaction(async tx => {
    const publication = await tx.scheduledPublication.findFirst({ where: { workspaceId, idempotencyKey: operationKey, metaContainerId: containerId }, select: { id: true } });
    if (!publication) throw new BillingError("PUBLICATION_PROOF_MISMATCH");
    const row = await tx.commercialUsageReservation.findUnique({ where: { workspaceId_resource_operationKey: { workspaceId, resource: "PUBLICATION", operationKey } } });
    if (!row || !["RESERVED", "DISPATCHING"].includes(row.status)) return false;
    const claim = await tx.commercialUsageReservation.updateMany({ where: { id: row.id, workspaceId, status: row.status, dispatchToken: row.dispatchToken },
      data: { status: "COMMITTED", dispatchToken: row.dispatchToken ?? randomUUID() } });
    if (claim.count !== 1) return false;
    await tx.commercialUsageBucket.update({ where: { id: row.bucketId }, data: { reserved: { decrement: row.amount }, consumed: { increment: row.amount } } });
    return true;
  });
}

/** Release is safe before dispatch or after a proven rejection only. It makes
 * cancellation terminal. Never free unknown/confirmed sends.
 * There is deliberately no blanket expiry job or auto-reset for reservations. */
export async function releaseCommercialUsage(workspaceId: string, reservationId: string, transaction?: Tx) {
  if (!z.uuid().safeParse(reservationId).success) throw new BillingError("INVALID_USAGE_RESERVATION", 400);
  const run = async (tx: Tx) => {
    const row = await tx.commercialUsageReservation.findFirst({ where: { id: reservationId, workspaceId, status: { in: ["RESERVED", "REJECTED"] } } });
    if (!row) return false;
    const claim = await tx.commercialUsageReservation.updateMany({ where: { id: row.id, workspaceId, status: row.status }, data: { status: "RELEASED" } });
    if (claim.count !== 1) return false;
    if (row.status === "RESERVED") await tx.commercialUsageBucket.update({ where: { id: row.bucketId }, data: { reserved: { decrement: row.amount } } });
    return true;
  };
  return transaction ? run(transaction) : prisma.$transaction(run);
}
