import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import type { z } from "zod";
import { ALLOWED_MEDIA, type createAssetSchema, type confirmAssetSchema } from "@/lib/publishing/schemas";
import { createSignedUpload, deletePrivateObject, getPrivateBucketUploadLimit, inspectPrivateObject, matchesDeclaredMedia, mediaStoragePath, SIGNED_UPLOAD_TTL_MS } from "@/lib/publishing/storage";
import { loadCommercialEntitlement } from "./commercial-access";
import { BillingError } from "./config";

type Tx = Prisma.TransactionClient;
type UploadInput = z.infer<typeof createAssetSchema>;
type Confirmation = z.infer<typeof confirmAssetSchema>;
const assetDTO = { id: true, filename: true, mimeType: true, mediaType: true, byteSize: true, status: true } as const;
const confirmationDTO = { ...assetDTO, width: true, height: true, durationMs: true } as const;
const VALIDATION_FAILED = "UPLOAD_VALIDATION_FAILED";
const RECOVERY_REQUIRED = "UPLOAD_RECOVERY_REQUIRED";
const SIGNING_FAILED = "UPLOAD_SIGNING_UNAVAILABLE";
export class CommercialStorageError extends BillingError {
  constructor(code: string, httpStatus: number, readonly retryAfter?: number) { super(code, httpStatus); }
}
async function lockOwner(tx: Tx, workspaceId: string) {
  const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
  if (!workspace) throw new CommercialStorageError("MEDIA_NOT_FOUND", 404);
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${workspace.ownerId} FOR UPDATE`;
  const current = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
  if (current?.ownerId !== workspace.ownerId) throw new CommercialStorageError("STORAGE_SCOPE_CHANGED", 409);
  return workspace.ownerId;
}

/** The whole bucket maximum is the allocation, never the client-declared size.
 * Owner→WorkspaceBilling lock order matches capacity admission. No HTTP occurs
 * inside this transaction. Trial counts every retained asset owned by this owner;
 * paid admission counts this workspace's retained trial/paid assets together.
 */
export async function reserveCommercialStorageAsset(workspaceId: string, input: UploadInput, capacityBytes: number) {
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) throw new CommercialStorageError("STORAGE_BUCKET_LIMIT_UNAVAILABLE", 503);
  if (input.byteSize > capacityBytes) throw new CommercialStorageError("MEDIA_EXCEEDS_BUCKET_LIMIT", 400);
  return prisma.$transaction(async tx => {
    const ownerId = await lockOwner(tx, workspaceId);
    const entitlement = await loadCommercialEntitlement(tx, workspaceId, new Date());
    if (!entitlement || entitlement.status === "denied") throw new CommercialStorageError("COMMERCIAL_ACCESS_DENIED", 402);
    const retained: Prisma.PublishingAssetWhereInput = { storageDeletedAt: null,
      ...(entitlement.subjectKind === "OWNER_TRIAL" ? { workspace: { ownerId } } : { workspaceId }) };
    // Old UPLOADING/FAILED/DELETED rows have no trustworthy byte baseline. A
    // missing object is not evidence that a previously issued upload was aborted.
    if (await tx.publishingAsset.findFirst({ where: { ...retained, uploadCapacityBytes: null, OR: [{ status: { not: "READY" } }, { byteSize: { lte: 0 } }] }, select: { id: true } }))
      throw new CommercialStorageError("STORAGE_BASELINE_UNVERIFIED", 503);
    const [held, legacy] = await Promise.all([
      tx.publishingAsset.aggregate({ where: { ...retained, uploadCapacityBytes: { not: null } }, _sum: { uploadCapacityBytes: true } }),
      tx.publishingAsset.aggregate({ where: { ...retained, uploadCapacityBytes: null, status: "READY" }, _sum: { byteSize: true } }),
    ]);
    const baseline = legacy._sum.byteSize ?? 0;
    if (!Number.isSafeInteger(baseline) || baseline < 0) throw new CommercialStorageError("STORAGE_BASELINE_UNVERIFIED", 503);
    if ((held._sum.uploadCapacityBytes ?? BigInt(0)) + BigInt(baseline) + BigInt(capacityBytes) > BigInt(entitlement.limits.storageBytes))
      throw new CommercialStorageError("COMMERCIAL_STORAGE_LIMIT", 409);
    const id = randomUUID();
    return tx.publishingAsset.create({ data: { id, workspaceId, filename: input.filename, storagePath: mediaStoragePath(workspaceId, id, input.filename),
      mimeType: input.mimeType, mediaType: ALLOWED_MEDIA[input.mimeType].mediaType, byteSize: input.byteSize, checksum: input.checksum,
      uploadCapacityBytes: BigInt(capacityBytes) } });
  });
}

/** Called exclusively before returning a URL/token to the client. A failed
 * persistence attempt retains the hold unless this explicit cleanup commits. */
async function failBeforeExposure(workspaceId: string, id: string) {
  await prisma.$transaction(async tx => {
    await lockOwner(tx, workspaceId);
    await tx.publishingAsset.updateMany({ where: { id, workspaceId, status: "UPLOADING" },
      data: { status: "FAILED", uploadCapacityBytes: BigInt(0), uploadTokenExpiresAt: null, errorMessage: SIGNING_FAILED } });
  }).catch(() => {});
}
export async function prepareCommercialMediaUpload(workspaceId: string, input: UploadInput) {
  let capacity: number;
  try { capacity = await getPrivateBucketUploadLimit(); } catch { throw new CommercialStorageError("STORAGE_BUCKET_LIMIT_UNAVAILABLE", 503); }
  const asset = await reserveCommercialStorageAsset(workspaceId, input, capacity);
  try {
    const signedUpload = await createSignedUpload(asset.storagePath, { commercial: true });
    if (!("expiresAt" in signedUpload) || !(signedUpload.expiresAt instanceof Date)) throw new Error();
    const saved = await prisma.publishingAsset.updateMany({ where: { id: asset.id, workspaceId, status: "UPLOADING", uploadTokenExpiresAt: null },
      data: { uploadTokenExpiresAt: signedUpload.expiresAt } });
    if (saved.count !== 1) throw new Error();
    return { asset: { id: asset.id, filename: asset.filename, mimeType: asset.mimeType, mediaType: asset.mediaType, byteSize: asset.byteSize, status: asset.status },
      signedUpload: { uploadUrl: signedUpload.uploadUrl, token: signedUpload.token } };
  } catch {
    await failBeforeExposure(workspaceId, asset.id);
    throw new CommercialStorageError("UPLOAD_SIGNING_UNAVAILABLE", 503);
  }
}

export async function confirmCommercialMediaUpload(workspaceId: string, input: Confirmation) {
  const before = await prisma.publishingAsset.findFirst({ where: { id: input.id, workspaceId } });
  if (!before) throw new CommercialStorageError("MEDIA_NOT_FOUND", 404);
  if (before.status !== "UPLOADING" && !(before.status === "FAILED" && before.errorMessage === RECOVERY_REQUIRED)) throw new CommercialStorageError("MEDIA_NOT_AWAITING_UPLOAD", 409);
  let object: Awaited<ReturnType<typeof inspectPrivateObject>>;
  try { object = await inspectPrivateObject(before.storagePath, { commercial: true }); } catch { throw new CommercialStorageError("STORAGE_INSPECTION_UNAVAILABLE", 503); }
  if (!object) throw new CommercialStorageError("UPLOAD_NOT_CONFIRMED", 409);
  return prisma.$transaction(async tx => {
    await lockOwner(tx, workspaceId);
    const asset = await tx.publishingAsset.findFirst({ where: { id: input.id, workspaceId } });
    if (!asset || asset.storagePath !== before.storagePath || asset.storageDeletedAt || (asset.status !== "UPLOADING" && !(asset.status === "FAILED" && asset.errorMessage === RECOVERY_REQUIRED)))
      throw new CommercialStorageError("MEDIA_NOT_AWAITING_UPLOAD", 409);
    const allowed = ALLOWED_MEDIA[asset.mimeType as keyof typeof ALLOWED_MEDIA];
    if (!allowed || object.byteSize > allowed.maxBytes || (asset.uploadCapacityBytes !== null && BigInt(object.byteSize) > asset.uploadCapacityBytes) || !matchesDeclaredMedia(object.prefix, asset.mediaType)) {
      await tx.publishingAsset.update({ where: { id: asset.id }, data: { status: "FAILED", errorMessage: VALIDATION_FAILED,
        uploadCapacityBytes: asset.uploadCapacityBytes === null || BigInt(object.byteSize) > asset.uploadCapacityBytes ? BigInt(object.byteSize) : asset.uploadCapacityBytes,
        uploadTokenExpiresAt: asset.uploadTokenExpiresAt ?? new Date(asset.createdAt.getTime() + SIGNED_UPLOAD_TTL_MS) } });
      return { valid: false as const };
    }
    const updated = await tx.publishingAsset.update({ where: { id: asset.id }, data: { status: "READY", errorMessage: null, byteSize: object.byteSize,
      uploadCapacityBytes: BigInt(object.byteSize), width: input.width, height: input.height, durationMs: input.durationMs,
      uploadTokenExpiresAt: asset.uploadTokenExpiresAt ?? new Date(asset.createdAt.getTime() + SIGNED_UPLOAD_TTL_MS) }, select: confirmationDTO });
    return { valid: true as const, asset: updated };
  });
}

/** No automatic release for incomplete/absent uploads, even after token expiry.
 * Only a previously confirmed object may be removed after expiry. A successful
 * DELETE plus authoritative404 permits releasing its actual retained bytes.
 */
export async function deleteCommercialMedia(workspaceId: string, id: string) {
  const decision = await prisma.$transaction(async tx => {
    await lockOwner(tx, workspaceId);
    const asset = await tx.publishingAsset.findFirst({ where: { id, workspaceId }, include: { _count: { select: { publications: true } } } });
    if (!asset) throw new CommercialStorageError("MEDIA_NOT_FOUND", 404);
    if (asset._count.publications) throw new CommercialStorageError("MEDIA_IN_USE", 409);
    if (asset.storageDeletedAt) return { kind: "DONE" as const };
    if (asset.uploadCapacityBytes === BigInt(0) && asset.errorMessage === SIGNING_FAILED) {
      await tx.publishingAsset.update({ where: { id }, data: { status: "DELETED", storageDeletedAt: new Date() } });
      return { kind: "DONE" as const };
    }
    const expiry = asset.uploadTokenExpiresAt ?? (asset.status === "READY" ? new Date(asset.createdAt.getTime() + SIGNED_UPLOAD_TTL_MS) : null);
    if (expiry && expiry > new Date()) throw new CommercialStorageError("UPLOAD_TOKEN_STILL_VALID", 409, Math.max(1, Math.ceil((expiry.getTime() - Date.now()) / 1000)));
    const proven = asset.status === "READY" || (asset.status === "FAILED" && asset.errorMessage === VALIDATION_FAILED)
      || (asset.status === "DELETED" && asset.uploadCapacityBytes !== null);
    if (!proven || !expiry) {
      await tx.publishingAsset.update({ where: { id }, data: { status: "FAILED", errorMessage: RECOVERY_REQUIRED } });
      return { kind: "RECOVERY" as const };
    }
    await tx.publishingAsset.update({ where: { id }, data: { status: "DELETED", uploadTokenExpiresAt: expiry,
      uploadCapacityBytes: asset.uploadCapacityBytes ?? BigInt(asset.byteSize) } });
    return { kind: "DELETE" as const, storagePath: asset.storagePath };
  });
  if (decision.kind === "DONE") return;
  if (decision.kind === "RECOVERY") throw new CommercialStorageError("UPLOAD_RECOVERY_REQUIRED", 409);
  try {
    await deletePrivateObject(decision.storagePath, { commercial: true });
    if (await inspectPrivateObject(decision.storagePath, { commercial: true })) throw new Error();
  } catch { throw new CommercialStorageError("STORAGE_DELETION_UNCONFIRMED", 503); }
  await prisma.$transaction(async tx => {
    await lockOwner(tx, workspaceId);
    const saved = await tx.publishingAsset.updateMany({ where: { id, workspaceId, status: "DELETED", storageDeletedAt: null },
      data: { storageDeletedAt: new Date(), uploadCapacityBytes: BigInt(0) } });
    if (saved.count !== 1 && !(await tx.publishingAsset.findFirst({ where: { id, workspaceId, status: "DELETED", storageDeletedAt: { not: null } }, select: { id: true } })))
      throw new CommercialStorageError("STORAGE_DELETION_UNCONFIRMED", 503);
  });
}
