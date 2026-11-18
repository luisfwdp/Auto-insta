/** Storage admissions/lifecycle on isolated disposable PostgreSQL; all object
 * service operations are mocked. This does not prove real Supabase delivery.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const url = process.env.TEST_DATABASE_URL, schema = `commercial_storage_${randomBytes(5).toString("hex")}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient, bucket: vi.fn(), sign: vi.fn(), inspect: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/publishing/storage", async importOriginal => ({ ...await importOriginal<typeof import("../lib/publishing/storage")>(),
  getPrivateBucketUploadLimit: state.bucket, createSignedUpload: state.sign, inspectPrivateObject: state.inspect, deletePrivateObject: state.remove }));
import { startCardFreeTrial } from "../lib/billing/trial";
import { saoPauloDate } from "../lib/billing/config";
import { monthlyInvoicePeriod } from "../lib/billing/financial-policy";
import { prepareCommercialMediaUpload, reserveCommercialStorageAsset, confirmCommercialMediaUpload, deleteCommercialMedia } from "../lib/billing/commercial-storage";
const cap = 300 * 1024 * 1024, input = { filename: "image.jpg", mimeType: "image/jpeg" as const, byteSize: 1 };
const scope = "10000000-0000-4000-8000-000000000001";
const good = { byteSize: 500, contentType: "image/jpeg", prefix: new Uint8Array([255, 216, 255, 224]) };
let sql: Client;
async function asset(patch: Partial<import("../app/generated/prisma/client").Prisma.PublishingAssetUncheckedCreateInput> = {}) {
  const id = randomUUID();
  return state.db.publishingAsset.create({ data: { id, workspaceId: "workspace-a", filename: "legacy.jpg", storagePath: `workspace-a/${id}.jpg`, mimeType: "image/jpeg", mediaType: "IMAGE", byteSize: 500, status: "READY", ...patch } });
}
async function paid() {
  const dueDate = saoPauloDate(new Date()), anchor = Number(dueDate.slice(-2)), period = monthlyInvoicePeriod(dueDate, anchor);
  const checkout = await state.db.billingCheckout.create({ data: { workspaceId: "workspace-a", environment: "sandbox", accountScope: scope, requestId: randomUUID(), planId: "pro-v1", amountCents: 14900, firstChargeDate: dueDate, billingAnchorDay: anchor, status: "COMPLETED" } });
  const sub = await state.db.billingSubscription.create({ data: { workspaceId: "workspace-a", environment: "sandbox", accountScope: scope, providerSubscriptionId: "sub_storage", providerCustomerId: "cus_storage", checkoutId: checkout.id, planId: "pro-v1", amountCents: 14900, billingAnchorDay: anchor, renewalStatus: "ACTIVE" } });
  await state.db.billingPayment.create({ data: { workspaceId: "workspace-a", subscriptionId: sub.id, environment: "sandbox", accountScope: scope, providerPaymentId: "pay_storage", amountCents: 14900, dueDate, status: "CONFIRMED", deleted: false } });
  await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { currentSubscriptionId: sub.id, status: "ACTIVE", planId: "pro-v1", paidThrough: period.endsAt } });
}
async function confirmed() {
  const upload = await prepareCommercialMediaUpload("workspace-a", input);
  state.inspect.mockResolvedValue(good); expect((await confirmCommercialMediaUpload("workspace-a", { id: upload.asset.id })).valid).toBe(true);
  return upload.asset.id;
}
async function expire(id: string) { await state.db.publishingAsset.update({ where: { id }, data: { uploadTokenExpiresAt: new Date(Date.now() - 1000) } }); }

describe.skipIf(!url)("commercial retained storage on PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect(); await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort()) await sql.query(readFileSync(path.join(root, dir, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10, options: `-c search_path=${schema}` }, { schema }) });
    for (const id of ["storage-owner", "other-owner"]) await state.db.user.create({ data: { id, email: `${id}@example.test` } });
    for (const id of ["workspace-a", "workspace-b", "workspace-c"]) await state.db.workspace.create({ data: { id, name: id, ownerId: id === "workspace-c" ? "other-owner" : "storage-owner" } });
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.clearAllMocks();
    vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scope); vi.stubEnv("VERCEL_ENV", "test"); vi.stubEnv("FLY_APP_NAME", "local-test");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No real HTTP permitted"));
    await state.db.publishingAsset.deleteMany(); await state.db.workspaceBilling.updateMany({ data: { currentSubscriptionId: null } });
    await state.db.billingPayment.deleteMany(); await state.db.billingCommand.deleteMany(); await state.db.billingEvent.deleteMany(); await state.db.billingSubscription.deleteMany(); await state.db.billingCheckout.deleteMany();
    await state.db.workspaceBilling.deleteMany(); await state.db.trialRedemption.deleteMany();
    for (const workspace of ["workspace-a", "workspace-b", "workspace-c"]) await startCardFreeTrial(workspace);
    state.bucket.mockResolvedValue(cap); state.inspect.mockResolvedValue(null); state.remove.mockResolvedValue(undefined);
    state.sign.mockImplementation(async (storagePath: string) => ({ uploadUrl: `https://storage.example.test/upload/${storagePath}?token=fake`, token: "fake", expiresAt: new Date(Date.now() + 7200000) }));
  });
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await state.db?.$disconnect(); if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });

  it("serializes100 one-byte-declared files across two workspaces of one owner against the real bucket ceiling", async () => {
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => prepareCommercialMediaUpload(i % 2 ? "workspace-a" : "workspace-b", input)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(97);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "COMMERCIAL_STORAGE_LIMIT" });
    expect(state.sign).toHaveBeenCalledTimes(3); expect(await state.db.publishingAsset.count()).toBe(3);
    expect((await state.db.publishingAsset.aggregate({ _sum: { uploadCapacityBytes: true } }))._sum.uploadCapacityBytes).toBe(BigInt(cap) * BigInt(3));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("rejects an honestly declared file larger than the real bucket limit before allocating or signing", async () => {
    await expect(reserveCommercialStorageAsset("workspace-a", { ...input, byteSize: 5000 }, 1000)).rejects.toMatchObject({ code: "MEDIA_EXCEEDS_BUCKET_LIMIT", httpStatus: 400 });
    expect(await state.db.publishingAsset.count()).toBe(0); expect(state.sign).not.toHaveBeenCalled();
  });
  it("prevents workspace deletion from discarding retained object metadata or resetting its owner storage hold", async () => {
    const upload = await prepareCommercialMediaUpload("workspace-a", input);
    const before = await state.db.publishingAsset.findUniqueOrThrow({ where: { id: upload.asset.id } });
    await expect(sql.query(`DELETE FROM "Workspace" WHERE id=$1`, ["workspace-a"])).rejects.toMatchObject({ constraint: "PublishingAsset_workspaceId_fkey" });
    expect(await state.db.publishingAsset.findUniqueOrThrow({ where: { id: upload.asset.id } })).toEqual(before);
    expect(await state.db.workspace.findUnique({ where: { id: "workspace-a" } })).not.toBeNull();
    expect(await state.db.workspaceBilling.findUnique({ where: { workspaceId: "workspace-a" } })).not.toBeNull();
    expect(before.uploadCapacityBytes).toBe(BigInt(cap));
  });
  it("persists the ceiling and tenant path before signing, with no owner/workspace database lock across network", async () => {
    state.sign.mockImplementationOnce(async (storagePath: string) => {
      const row = await state.db.publishingAsset.findUniqueOrThrow({ where: { storagePath } });
      expect(row).toMatchObject({ workspaceId: "workspace-a", status: "UPLOADING", byteSize: 1, uploadCapacityBytes: BigInt(cap), uploadTokenExpiresAt: null });
      await state.db.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM "User" WHERE id='storage-owner' FOR UPDATE NOWAIT`; await tx.$queryRaw`SELECT "workspaceId" FROM "WorkspaceBilling" WHERE "workspaceId"='workspace-a' FOR UPDATE NOWAIT`; });
      return { uploadUrl: "https://storage.example.test/upload?token=fake", token: "fake", expiresAt: new Date(Date.now() + 7200000) };
    });
    const result = await prepareCommercialMediaUpload("workspace-a", input);
    expect((await state.db.publishingAsset.findUniqueOrThrow({ where: { id: result.asset.id } })).uploadTokenExpiresAt).not.toBeNull();
    expect(result.asset).not.toHaveProperty("uploadCapacityBytes");
  });
  it("releases only pre-exposure signing failures and never exposes provider errors", async () => {
    state.sign.mockRejectedValueOnce(new Error("fake-provider-private-token"));
    await expect(prepareCommercialMediaUpload("workspace-a", input)).rejects.toMatchObject({ code: "UPLOAD_SIGNING_UNAVAILABLE" });
    expect(await state.db.publishingAsset.findFirstOrThrow()).toMatchObject({ status: "FAILED", uploadCapacityBytes: BigInt(0), uploadTokenExpiresAt: null });
    expect(state.remove).not.toHaveBeenCalled();
  });
  it("does not expose a signed URL after expiry persistence fails; explicit pre-exposure cleanup may free the hold", async () => {
    vi.spyOn(state.db.publishingAsset, "updateMany").mockRejectedValueOnce(new Error("Simulated database write failure"));
    await expect(prepareCommercialMediaUpload("workspace-a", input)).rejects.toMatchObject({ code: "UPLOAD_SIGNING_UNAVAILABLE" });
    expect(await state.db.publishingAsset.findFirstOrThrow()).toMatchObject({ status: "FAILED", uploadCapacityBytes: BigInt(0) });
  });
  it("uses provider-observed bytes only after content confirmation and retains the token lifetime", async () => {
    const upload = await prepareCommercialMediaUpload("workspace-a", input), before = await state.db.publishingAsset.findUniqueOrThrow({ where: { id: upload.asset.id } });
    state.inspect.mockResolvedValue(good); expect(await confirmCommercialMediaUpload("workspace-a", { id: upload.asset.id, width: 20 })).toMatchObject({ valid: true, asset: { status: "READY", byteSize: 500, width: 20 } });
    expect(await state.db.publishingAsset.findUniqueOrThrow({ where: { id: upload.asset.id } })).toMatchObject({ uploadCapacityBytes: BigInt(500), uploadTokenExpiresAt: before.uploadTokenExpiresAt });
  });
  it.each(["magic", "oversize"])("invalid %s never deletes or frees capacity while the upload token remains valid", async kind => {
    const upload = await prepareCommercialMediaUpload("workspace-a", input);
    state.inspect.mockResolvedValue(kind === "magic" ? { ...good, prefix: new TextEncoder().encode("MZ executable") } : { ...good, byteSize: 9 * 1024 * 1024 });
    expect(await confirmCommercialMediaUpload("workspace-a", { id: upload.asset.id })).toEqual({ valid: false });
    expect(await state.db.publishingAsset.findUniqueOrThrow({ where: { id: upload.asset.id } })).toMatchObject({ status: "FAILED", uploadCapacityBytes: BigInt(cap), storageDeletedAt: null });
    await expect(deleteCommercialMedia("workspace-a", upload.asset.id)).rejects.toMatchObject({ code: "UPLOAD_TOKEN_STILL_VALID", httpStatus: 409 });
    expect(state.remove).not.toHaveBeenCalled();
  });
  it("refuses deleting READY data before token expiry with a bounded Retry-After", async () => {
    const id = await confirmed();
    await expect(deleteCommercialMedia("workspace-a", id)).rejects.toMatchObject({ code: "UPLOAD_TOKEN_STILL_VALID", httpStatus: 409, retryAfter: expect.any(Number) });
    expect(state.remove).not.toHaveBeenCalled(); expect((await state.db.publishingAsset.findUniqueOrThrow({ where: { id } })).status).toBe("READY");
  });
  it("releases actual retained bytes only after expired READY DELETE succeeds and HEAD proves absence", async () => {
    const id = await confirmed(); await expire(id); state.inspect.mockResolvedValue(null);
    await deleteCommercialMedia("workspace-a", id);
    expect(state.remove).toHaveBeenCalledOnce(); expect(await state.db.publishingAsset.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DELETED", uploadCapacityBytes: BigInt(0), storageDeletedAt: expect.any(Date) });
  });
  it.each(["delete failed", "object still exists", "HEAD unavailable"])("retains capacity after %s and allows explicit cleanup retry", async scenario => {
    const id = await confirmed(); await expire(id);
    if (scenario === "delete failed") state.remove.mockRejectedValueOnce(new Error("provider unavailable"));
    if (scenario === "HEAD unavailable") state.inspect.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(deleteCommercialMedia("workspace-a", id)).rejects.toMatchObject({ code: "STORAGE_DELETION_UNCONFIRMED" });
    expect(await state.db.publishingAsset.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DELETED", uploadCapacityBytes: BigInt(500), storageDeletedAt: null });
    state.inspect.mockResolvedValue(null); await deleteCommercialMedia("workspace-a", id);
    expect((await state.db.publishingAsset.findUniqueOrThrow({ where: { id } })).uploadCapacityBytes).toBe(BigInt(0));
  });
  it("allows explicit cleanup of an invalid but confirmed object after expiry and verified deletion", async () => {
    const upload = await prepareCommercialMediaUpload("workspace-a", input); state.inspect.mockResolvedValue({ ...good, prefix: new TextEncoder().encode("invalid media") });
    expect(await confirmCommercialMediaUpload("workspace-a", { id: upload.asset.id })).toEqual({ valid: false });
    await expire(upload.asset.id); state.inspect.mockResolvedValue(null); await deleteCommercialMedia("workspace-a", upload.asset.id);
    expect(await state.db.publishingAsset.findUniqueOrThrow({ where: { id: upload.asset.id } })).toMatchObject({ status: "DELETED", uploadCapacityBytes: BigInt(0), storageDeletedAt: expect.any(Date) });
  });
  it("does not release expired incomplete uploads even if an object could still be in flight; explicit confirmation can recover later", async () => {
    const upload = await prepareCommercialMediaUpload("workspace-a", input); await expire(upload.asset.id); state.inspect.mockResolvedValue(null);
    await expect(deleteCommercialMedia("workspace-a", upload.asset.id)).rejects.toMatchObject({ code: "UPLOAD_RECOVERY_REQUIRED" });
    expect(state.inspect).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
    expect(await state.db.publishingAsset.findUniqueOrThrow({ where: { id: upload.asset.id } })).toMatchObject({ status: "FAILED", uploadCapacityBytes: BigInt(cap), storageDeletedAt: null });
    state.inspect.mockResolvedValue(good); expect((await confirmCommercialMediaUpload("workspace-a", { id: upload.asset.id })).valid).toBe(true);
  });
  it.each(["UPLOADING", "FAILED", "DELETED"] as const)("does not trust unmeasured legacy %s bytes as a retained-storage baseline", async status => {
    await asset({ status, byteSize: 1 });
    await expect(prepareCommercialMediaUpload("workspace-a", input)).rejects.toMatchObject({ code: "STORAGE_BASELINE_UNVERIFIED" }); expect(state.sign).not.toHaveBeenCalled();
  });
  it("counts old READY bytes and trial assets after upgrade, with no monthly/lifecycle reset", async () => {
    await asset({ byteSize: cap, createdAt: new Date("2000-01-01") }); await paid();
    await expect(reserveCommercialStorageAsset("workspace-a", input, 10_000_000_000)).rejects.toMatchObject({ code: "COMMERCIAL_STORAGE_LIMIT" });
    await expect(reserveCommercialStorageAsset("workspace-a", input, cap)).resolves.toMatchObject({ uploadCapacityBytes: BigInt(cap) });
  });
  it("never sums another owner's assets and limits a paid workspace independently of its owner's other workspaces", async () => {
    for (let i = 0; i < 3; i++) await asset({ workspaceId: "workspace-c", byteSize: 1_000_000_000 });
    await expect(prepareCommercialMediaUpload("workspace-a", input)).resolves.toHaveProperty("asset.id");
    await paid(); await asset({ workspaceId: "workspace-b", status: "UPLOADING", byteSize: 1, uploadCapacityBytes: BigInt(9_000_000_000) });
    await expect(prepareCommercialMediaUpload("workspace-a", input)).resolves.toHaveProperty("asset.id");
  });
  it("scopes confirmation/deletion to the active workspace even for another workspace of the same owner", async () => {
    const upload = await prepareCommercialMediaUpload("workspace-a", input);
    await expect(confirmCommercialMediaUpload("workspace-b", { id: upload.asset.id })).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND", httpStatus: 404 });
    await expect(deleteCommercialMedia("workspace-b", upload.asset.id)).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND", httpStatus: 404 });
    expect(state.inspect).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
  });
  it("does not treat provider metadata failure as object absence or release an unconfirmed allocation", async () => {
    const upload = await prepareCommercialMediaUpload("workspace-a", input); state.inspect.mockRejectedValueOnce(new Error("HEAD forbidden"));
    await expect(confirmCommercialMediaUpload("workspace-a", { id: upload.asset.id })).rejects.toMatchObject({ code: "STORAGE_INSPECTION_UNAVAILABLE" });
    expect((await state.db.publishingAsset.findUniqueOrThrow({ where: { id: upload.asset.id } })).uploadCapacityBytes).toBe(BigInt(cap));
  });
});
