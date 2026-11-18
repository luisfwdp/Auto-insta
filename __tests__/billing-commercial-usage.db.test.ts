/** Commercial allocation/dispatch races on isolated PostgreSQL schemas.
 * Paid fixtures are local canonical ledger seeds, never real payment evidence.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type CommercialUsageResource } from "../app/generated/prisma/client";
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL, schema = `commercial_usage_${randomBytes(5).toString("hex")}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { reserveCommercialUsage, beginCommercialDispatch, finishCommercialDispatch, releaseCommercialUsage, readCommercialUsageReceipt } from "../lib/billing/commercial-usage";
import { BILLING_PLANS, type BillingPlanId } from "../lib/billing/catalog";
import { monthlyInvoicePeriod } from "../lib/billing/financial-policy";
import { saoPauloDate } from "../lib/billing/config";

const scope = "1eb34a1e-82b8-4a6f-a67a-202654136d47";
let sql: Client, trialStartedAt: Date, trialEndsAt: Date;
async function reservation(workspaceId = "workspace-a", resource: CommercialUsageResource = "DM", key: string = randomUUID(), amount = 1) {
  const row = await reserveCommercialUsage(workspaceId, resource, key, amount);
  if (!row.reservationId) throw new Error("Expected a commercial fixture reservation");
  return row.reservationId;
}
async function usage(id: string) {
  return state.db.commercialUsageReservation.findUniqueOrThrow({ where: { id }, include: { bucket: true } });
}
async function makePaid(workspaceId = "workspace-a", planId: BillingPlanId = "pro-v1") {
  const date = saoPauloDate(new Date()), anchor = Number(date.slice(-2)), period = monthlyInvoicePeriod(date, anchor), plan = BILLING_PLANS[planId];
  const checkout = await state.db.billingCheckout.create({ data: { workspaceId, environment: "sandbox", accountScope: scope, requestId: randomUUID(), planId,
    amountCents: plan.amountCents, firstChargeDate: date, billingAnchorDay: anchor, status: "COMPLETED", providerCheckoutId: randomUUID() } });
  const sub = await state.db.billingSubscription.create({ data: { workspaceId, environment: "sandbox", accountScope: scope, providerSubscriptionId: `sub_${randomBytes(5).toString("hex")}`,
    providerCustomerId: "cus_fixture", checkoutId: checkout.id, planId, amountCents: plan.amountCents, billingAnchorDay: anchor, renewalStatus: "ACTIVE" } });
  await state.db.billingPayment.create({ data: { workspaceId, subscriptionId: sub.id, environment: "sandbox", accountScope: scope, providerPaymentId: `pay_${randomBytes(5).toString("hex")}`,
    amountCents: plan.amountCents, dueDate: date, status: "CONFIRMED", deleted: false } });
  await state.db.workspaceBilling.update({ where: { workspaceId }, data: { status: "ACTIVE", currentSubscriptionId: sub.id, planId, paidThrough: period.endsAt } });
  return { sub, period, plan };
}

describe.skipIf(!url)("commercial usage allocation and dispatch", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect(); await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const migrations = path.join(__dirname, "..", "prisma", "migrations");
    for (const directory of readdirSync(migrations, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort()) await sql.query(readFileSync(path.join(migrations, directory, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10, options: `-c search_path=${schema}` }, { schema }) });
    await state.db.user.createMany({ data: [{ id: "owner-a", email: "owner-a@example.test" }, { id: "owner-b", email: "owner-b@example.test" }] });
    await state.db.workspace.createMany({ data: [{ id: "workspace-a", name: "A", ownerId: "owner-a" }, { id: "workspace-b", name: "B", ownerId: "owner-a" }, { id: "workspace-c", name: "C", ownerId: "owner-b" }] });
  });
  beforeEach(async () => {
    vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scope); vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("FLY_APP_NAME", ""); vi.stubEnv("ENCRYPTION_KEY", "11".repeat(32));
    await sql.query(`TRUNCATE TABLE "CommercialUsageReservation", "CommercialUsageBucket", "BillingEvent", "BillingCommand", "BillingPayment", "BillingSubscription", "BillingCheckout", "WorkspaceBilling", "TrialRedemption" CASCADE`);
    await state.db.workspace.updateMany({ where: { id: { in: ["workspace-a", "workspace-b"] } }, data: { ownerId: "owner-a" } });
    trialStartedAt = new Date(Date.now() - 600000); trialEndsAt = new Date(trialStartedAt.getTime() + 72 * 3600000);
    await state.db.trialRedemption.createMany({ data: ["owner-a", "owner-b"].map(ownerId => ({ ownerId, trialStartedAt, trialEndsAt })) });
    await state.db.workspaceBilling.createMany({ data: ["workspace-a", "workspace-b", "workspace-c"].map(workspaceId => ({ workspaceId, trialStartedAt, trialEndsAt })) });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll(async () => { vi.unstubAllEnvs(); await state.db?.$disconnect(); if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });

  it("allocates the same operation once under twenty concurrent retries", async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => reservation("workspace-a", "DM", "same-operation")));
    expect(new Set(ids).size).toBe(1); expect(await state.db.commercialUsageReservation.count()).toBe(1);
    expect((await usage(ids[0])).bucket).toMatchObject({ subjectKind: "OWNER_TRIAL", subjectId: "owner-a", reserved: BigInt(1), consumed: BigInt(0), limitSnapshot: BigInt(100) });
  });
  it("creates a cold owner-trial bucket safely from two different workspaces at once", async () => {
    const results = await Promise.allSettled([reservation("workspace-a", "DM", "cold-a"), reservation("workspace-b", "DM", "cold-b")]);
    const codes = results.map(result => result.status === "fulfilled" ? "RESERVED" : (result.reason as { code?: string }).code ?? "UNTYPED_ERROR");
    expect(codes).toEqual(["RESERVED", "RESERVED"]);
    expect(await state.db.commercialUsageBucket.count()).toBe(1); expect(await state.db.commercialUsageReservation.count()).toBe(2);
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ reserved: BigInt(2), consumed: BigInt(0) });
  });
  it("admits exactly one hundred distinct trial DMs across two workspaces of the same owner", async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 120 }, (_, index) => reservation(index % 2 ? "workspace-a" : "workspace-b", "DM", `dm_${index}`)));
    const accepted = attempts.filter(result => result.status === "fulfilled"), rejected = attempts.filter(result => result.status === "rejected");
    expect(accepted).toHaveLength(100); expect(rejected).toHaveLength(20);
    const errorCodes = rejected.reduce<Record<string, number>>((counts, result) => {
      const code = result.status === "rejected" ? (result.reason as { code?: string }).code ?? "UNTYPED_ERROR" : "UNEXPECTED_SUCCESS";
      counts[code] = (counts[code] ?? 0) + 1; return counts;
    }, {});
    expect(errorCodes).toEqual({ COMMERCIAL_QUOTA_EXCEEDED: 20 });
    for (const result of rejected) expect(result).toMatchObject({ reason: { code: "COMMERCIAL_QUOTA_EXCEEDED", httpStatus: 402 } });
    expect(await state.db.commercialUsageBucket.count()).toBe(1);
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ subjectId: "owner-a", reserved: BigInt(100), consumed: BigInt(0) });
    expect(await state.db.commercialUsageReservation.count()).toBe(100);
  });
  it("isolates different owners even when the client operation text and trial dates coincide", async () => {
    const a = await reservation("workspace-a", "DM", "shared-text", 100);
    const b = await reservation("workspace-c", "DM", "shared-text", 100);
    expect(a).not.toBe(b); expect(await state.db.commercialUsageBucket.count()).toBe(2);
    expect((await usage(a)).bucket.subjectId).toBe("owner-a"); expect((await usage(b)).bucket.subjectId).toBe("owner-b");
  });
  it("does not treat the same operation in separate owner workspaces as the same external effect", async () => {
    const a = await reservation("workspace-a", "DM", "same-key"), b = await reservation("workspace-b", "DM", "same-key");
    expect(a).not.toBe(b); expect((await usage(a)).bucketId).toBe((await usage(b)).bucketId);
    expect((await usage(a)).bucket.reserved).toBe(BigInt(2));
  });
  it("rejects a changed amount on the same stable operation without changing its counter", async () => {
    const id = await reservation("workspace-a", "DM", "immutable-amount", 1);
    await expect(reservation("workspace-a", "DM", "immutable-amount", 2)).rejects.toMatchObject({ code: "USAGE_OPERATION_CONFLICT" });
    expect((await usage(id)).amount).toBe(BigInt(1)); expect((await usage(id)).bucket.reserved).toBe(BigInt(1));
  });
  it("allows only one dispatch claim and commits a confirmed external effect once", async () => {
    const id = await reservation(), claims = await Promise.all(Array.from({ length: 20 }, () => beginCommercialDispatch("workspace-a", id)));
    expect(claims.filter(Boolean)).toHaveLength(1); const token = claims.find(Boolean)!.dispatchToken;
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => finishCommercialDispatch("workspace-a", id, token, "CONFIRMED")));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await usage(id)).toMatchObject({ status: "COMMITTED", bucket: { reserved: BigInt(0), consumed: BigInt(1) } });
    expect(await releaseCommercialUsage("workspace-a", id)).toBe(false);
  });
  it("can retry a definite provider rejection with a new token while rejecting the old owner", async () => {
    const key = randomUUID(), id = await reservation("workspace-a", "DM", key), first = await beginCommercialDispatch("workspace-a", id);
    expect(await finishCommercialDispatch("workspace-a", id, first!.dispatchToken, "DEFINITELY_REJECTED")).toBe(true);
    expect(await usage(id)).toMatchObject({ status: "REJECTED", dispatchToken: null, bucket: { reserved: BigInt(0), consumed: BigInt(0) } });
    expect(await beginCommercialDispatch("workspace-a", id)).toBeNull();
    expect(await reservation("workspace-a", "DM", key)).toBe(id);
    const second = await beginCommercialDispatch("workspace-a", id); expect(second!.dispatchToken).not.toBe(first!.dispatchToken);
    for (const outcome of ["CONFIRMED", "DEFINITELY_REJECTED"] as const) expect(await finishCommercialDispatch("workspace-a", id, first!.dispatchToken, outcome)).toBe(false);
    expect(await finishCommercialDispatch("workspace-a", id, second!.dispatchToken, "CONFIRMED")).toBe(true);
    expect((await usage(id)).bucket).toMatchObject({ reserved: BigInt(0), consumed: BigInt(1) });
  });
  it("holds an UNKNOWN delivery and never redispatches or releases it by retry", async () => {
    const id = await reservation(), claim = await beginCommercialDispatch("workspace-a", id);
    expect(await finishCommercialDispatch("workspace-a", id, claim!.dispatchToken, "UNKNOWN")).toBe(false);
    expect(await beginCommercialDispatch("workspace-a", id)).toBeNull(); expect(await releaseCommercialUsage("workspace-a", id)).toBe(false);
    expect(await usage(id)).toMatchObject({ status: "DISPATCHING", dispatchToken: claim!.dispatchToken, bucket: { reserved: BigInt(1), consumed: BigInt(0) } });
  });
  it("releases a rejected button attempt so its text fallback consumes only the one real DM", async () => {
    const button = await reservation("workspace-a", "DM", "reveal-button"), first = await beginCommercialDispatch("workspace-a", button);
    await finishCommercialDispatch("workspace-a", button, first!.dispatchToken, "DEFINITELY_REJECTED");
    const fallback = await reservation("workspace-a", "DM", "reveal-text"), second = await beginCommercialDispatch("workspace-a", fallback);
    await finishCommercialDispatch("workspace-a", fallback, second!.dispatchToken, "CONFIRMED", { messageId: "mid.$real+id/==" });
    expect((await usage(fallback)).bucket).toMatchObject({ reserved: BigInt(0), consumed: BigInt(1) });
  });
  it("rearms the same rejected operation once under twenty concurrent retries", async () => {
    const key = "rejected-concurrent", id = await reservation("workspace-a", "DM", key), claim = await beginCommercialDispatch("workspace-a", id);
    await finishCommercialDispatch("workspace-a", id, claim!.dispatchToken, "DEFINITELY_REJECTED");
    const ids = await Promise.all(Array.from({ length: 20 }, () => reservation("workspace-a", "DM", key)));
    expect(new Set(ids)).toEqual(new Set([id])); expect((await usage(id)).bucket.reserved).toBe(BigInt(1));
  });
  it("allows a proven rejected trial operation to retry against its paid allocation without using a stale free slot", async () => {
    const key = "rejected-upgrade", id = await reservation("workspace-a", "DM", key), claim = await beginCommercialDispatch("workspace-a", id), old = await usage(id);
    await finishCommercialDispatch("workspace-a", id, claim!.dispatchToken, "DEFINITELY_REJECTED"); await makePaid();
    expect(await reservation("workspace-a", "DM", key)).toBe(id);
    expect(await usage(id)).toMatchObject({ status: "RESERVED", bucket: { subjectKind: "WORKSPACE_PAID", reserved: BigInt(1), consumed: BigInt(0) } });
    expect(await state.db.commercialUsageBucket.findUniqueOrThrow({ where: { id: old.bucketId } })).toMatchObject({ reserved: BigInt(0), consumed: BigInt(0) });
  });
  it("binds a manual intent fingerprint across concurrent retries, rejection and receipt replay", async () => {
    const key = "manual-fixed", fingerprint = "a".repeat(64);
    const first = await reserveCommercialUsage("workspace-a", "DM", key, 1, fingerprint), id = first.reservationId!;
    for (const changed of [undefined, "b".repeat(64)]) await expect(reserveCommercialUsage("workspace-a", "DM", key, 1, changed)).rejects.toMatchObject({ code: "USAGE_OPERATION_CONFLICT" });
    const claim = await beginCommercialDispatch("workspace-a", id);
    await finishCommercialDispatch("workspace-a", id, claim!.dispatchToken, "DEFINITELY_REJECTED");
    await expect(reserveCommercialUsage("workspace-a", "DM", key, 1, "b".repeat(64))).rejects.toMatchObject({ code: "USAGE_OPERATION_CONFLICT" });
    await reserveCommercialUsage("workspace-a", "DM", key, 1, fingerprint); const retry = await beginCommercialDispatch("workspace-a", id);
    await finishCommercialDispatch("workspace-a", id, retry!.dispatchToken, "CONFIRMED", { messageId: "real-message", recipientId: "real-recipient" });
    await expect(sql.query(`UPDATE "CommercialUsageReservation" SET "intentFingerprint"=$1 WHERE "id"=$2`, ["b".repeat(64), id])).rejects.toMatchObject({ code: "23514" });
    expect(await readCommercialUsageReceipt("workspace-a", id)).toEqual({ messageId: "real-message", recipientId: "real-recipient" });
    expect(await readCommercialUsageReceipt("workspace-b", id)).toBeNull();
    expect((await usage(id)).receiptCiphertext).not.toContain("real-message");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(trialEndsAt.getTime() + 1);
    expect(await reserveCommercialUsage("workspace-a", "DM", key, 1, fingerprint)).toMatchObject({ status: "COMMITTED", reservationId: id });
    expect(await readCommercialUsageReceipt("workspace-a", id)).toEqual({ messageId: "real-message", recipientId: "real-recipient" });
  });
  it("keeps the first real receipt immutable and refuses unknown/extra provider fields", async () => {
    const id = await reservation(), claim = await beginCommercialDispatch("workspace-a", id);
    await expect(finishCommercialDispatch("workspace-a", id, claim!.dispatchToken, "CONFIRMED", { messageId: "id", token: "fake-untrusted" } as unknown as { messageId: string })).rejects.toMatchObject({ code: "INVALID_USAGE_RECEIPT" });
    expect((await usage(id)).status).toBe("DISPATCHING");
    await finishCommercialDispatch("workspace-a", id, claim!.dispatchToken, "CONFIRMED", { messageId: "id" });
    await expect(sql.query(`UPDATE "CommercialUsageReservation" SET "receiptCiphertext"='replacement' WHERE "id"=$1`, [id])).rejects.toMatchObject({ code: "23514" });
  });
  it("releases an unstarted operation once under concurrent duplicate cancellations", async () => {
    const id = await reservation(), results = await Promise.all(Array.from({ length: 20 }, () => releaseCommercialUsage("workspace-a", id)));
    expect(results.filter(Boolean)).toHaveLength(1); expect(await usage(id)).toMatchObject({ status: "RELEASED", bucket: { reserved: BigInt(0), consumed: BigInt(0) } });
    expect(await beginCommercialDispatch("workspace-a", id)).toBeNull();
  });
  it("allows cleanup after expiry but refuses to start a queued trial effect at the exact deadline", async () => {
    const id = await reservation(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(trialEndsAt);
    await expect(beginCommercialDispatch("workspace-a", id)).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_REQUIRED" });
    expect((await usage(id)).status).toBe("RESERVED"); expect(await releaseCommercialUsage("workspace-a", id)).toBe(true);
    expect((await usage(id)).bucket).toMatchObject({ reserved: BigInt(0), consumed: BigInt(0) });
  });
  it("finalizes an already made external effect after trial expiry without double counting it", async () => {
    const id = await reservation(), claim = await beginCommercialDispatch("workspace-a", id);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(trialEndsAt.getTime() + 1);
    expect(await finishCommercialDispatch("workspace-a", id, claim!.dispatchToken, "CONFIRMED")).toBe(true);
    expect(await finishCommercialDispatch("workspace-a", id, claim!.dispatchToken, "CONFIRMED")).toBe(false);
    expect((await usage(id)).bucket).toMatchObject({ reserved: BigInt(0), consumed: BigInt(1) });
  });
  it("refuses a trial reservation after upgrading to a different paid quota subject", async () => {
    const id = await reservation(); await makePaid();
    await expect(beginCommercialDispatch("workspace-a", id)).rejects.toMatchObject({ code: "USAGE_RESERVATION_STALE" });
    expect(await usage(id)).toMatchObject({ status: "RESERVED", bucket: { subjectKind: "OWNER_TRIAL", reserved: BigInt(1), consumed: BigInt(0) } });
  });
  it("does not allow a reservation from an old monthly invoice to dispatch after renewal", async () => {
    const paid = await makePaid(), id = await reservation();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(paid.period.endsAt.getTime() + 1);
    const nextDate = saoPauloDate(new Date()), next = monthlyInvoicePeriod(nextDate, paid.sub.billingAnchorDay);
    await state.db.billingPayment.create({ data: { workspaceId: "workspace-a", subscriptionId: paid.sub.id, environment: "sandbox", accountScope: scope,
      providerPaymentId: "pay_renewal", amountCents: paid.plan.amountCents, dueDate: nextDate, status: "CONFIRMED", deleted: false } });
    await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { paidThrough: next.endsAt } });
    await expect(beginCommercialDispatch("workspace-a", id)).rejects.toMatchObject({ code: "USAGE_RESERVATION_STALE" });
    expect((await usage(id)).bucket.periodStart).toEqual(paid.period.startsAt);
  });
  it("does not transfer another owner's trial quota when workspace ownership changes", async () => {
    const id = await reservation(); await state.db.workspace.update({ where: { id: "workspace-a" }, data: { ownerId: "owner-b" } });
    await expect(beginCommercialDispatch("workspace-a", id)).rejects.toMatchObject({ code: "USAGE_RESERVATION_STALE" });
    expect((await usage(id)).bucket.subjectId).toBe("owner-a");
  });
  it("denies dispatch under a different provider account scope instead of reusing the paid bucket", async () => {
    await makePaid(); const id = await reservation(); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", randomUUID());
    await expect(beginCommercialDispatch("workspace-a", id)).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_REQUIRED" });
    expect((await usage(id)).status).toBe("RESERVED");
  });
  it("does not read or write billing tables in the disabled legacy reservation path", async () => {
    vi.stubEnv("BILLING_ENABLED", "false"); const tx = vi.spyOn(state.db, "$transaction");
    expect(await reserveCommercialUsage("nonexistent-workspace", "DM", "legacy-op")).toEqual({ mode: "legacy", reservationId: null, status: null });
    expect(tx).not.toHaveBeenCalled(); expect(await state.db.commercialUsageReservation.count()).toBe(0);
  });
  it("rejects storage accounting before making any claim until retained-asset baselines are integrated", async () => {
    const tx = vi.spyOn(state.db, "$transaction");
    await expect(reservation("workspace-a", "STORAGE_BYTES", "storage-not-ready", 300000000)).rejects.toMatchObject({ code: "STORAGE_ENFORCEMENT_NOT_READY", httpStatus: 503 });
    expect(tx).not.toHaveBeenCalled(); expect(await state.db.commercialUsageBucket.count()).toBe(0);
  });
  it("counts publication and transfer resources separately and handles large byte quotas without int4 overflow", async () => {
    await makePaid("workspace-a", "agency-v1");
    const transfer = await reservation("workspace-a", "TRANSFER_BYTES", "large-transfer", 80_000_000_000);
    const publication = await reservation("workspace-a", "PUBLICATION", "large-transfer");
    expect((await usage(transfer)).bucketId).not.toBe((await usage(publication)).bucketId);
    expect((await usage(transfer)).bucket.reserved).toBe(BigInt(80_000_000_000));
    await expect(reservation("workspace-a", "TRANSFER_BYTES", "one-byte-too-many", 1)).rejects.toMatchObject({ code: "COMMERCIAL_QUOTA_EXCEEDED" });
  });
  it("keeps resource use bounded by the trial publication quota", async () => {
    const results = await Promise.allSettled(Array.from({ length: 11 }, (_, index) => reservation("workspace-a", "PUBLICATION", `publication_${index}`)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(10);
    expect(results.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "COMMERCIAL_QUOTA_EXCEEDED" } }]);
  });
  it("prevents a tenant from dispatching, committing or releasing another workspace's operation", async () => {
    const id = await reservation("workspace-a"), claim = await beginCommercialDispatch("workspace-a", id);
    expect(await beginCommercialDispatch("workspace-b", id)).toBeNull();
    expect(await finishCommercialDispatch("workspace-b", id, claim!.dispatchToken, "CONFIRMED")).toBe(false);
    expect(await releaseCommercialUsage("workspace-b", id)).toBe(false);
    expect(await usage(id)).toMatchObject({ status: "DISPATCHING", bucket: { reserved: BigInt(1), consumed: BigInt(0) } });
  });
  it.each([0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid usage amount%s before mutating counters", async amount => {
    await expect(reservation("workspace-a", "DM", "invalid-amount", amount)).rejects.toMatchObject({ code: "INVALID_USAGE_RESERVATION", httpStatus: 400 });
    expect(await state.db.commercialUsageBucket.count()).toBe(0);
  });
  it("enforces immutable usage identities and nonnegative counters directly in PostgreSQL", async () => {
    const id = await reservation(), row = await usage(id);
    for (const [table, column, value, key] of [
      ["CommercialUsageReservation", "amount", "2", id], ["CommercialUsageReservation", "operationKey", "'different-operation'", id],
      ["CommercialUsageBucket", "subjectId", "'owner-b'", row.bucketId], ["CommercialUsageBucket", "reserved", "-1", row.bucketId], ["CommercialUsageBucket", "consumed", "-1", row.bucketId],
    ]) await expect(sql.query(`UPDATE "${table}" SET "${column}"=${value} WHERE "id"=$1`, [key])).rejects.toMatchObject({ code: "23514" });
    await expect(sql.query(`UPDATE "CommercialUsageReservation" SET "status"='DISPATCHING', "dispatchToken"=NULL WHERE "id"=$1`, [id])).rejects.toMatchObject({ code: "23514" });
    expect(await usage(id)).toMatchObject({ status: "RESERVED", amount: BigInt(1), bucket: { subjectId: "owner-a", reserved: BigInt(1), consumed: BigInt(0) } });
  });
  it("enables row-level security on both server-only usage tables", async () => {
    const rows = await sql.query(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname IN ('CommercialUsageBucket','CommercialUsageReservation') ORDER BY c.relname`, [schema]);
    expect(rows.rows).toEqual([{ relname: "CommercialUsageBucket", relrowsecurity: true }, { relname: "CommercialUsageReservation", relrowsecurity: true }]);
  });
  it("rejects a trial reservation attached to another owner's bucket directly in PostgreSQL", async () => {
    const row = await usage(await reservation());
    await expect(sql.query(`INSERT INTO "CommercialUsageReservation" ("id","workspaceId","bucketId","resource","operationKey","amount","updatedAt") VALUES ($1,'workspace-c',$2,'DM','wrong-owner',1,NOW())`, [randomUUID(), row.bucketId])).rejects.toMatchObject({ code: "23514" });
    expect(await state.db.commercialUsageReservation.count()).toBe(1); expect((await usage(row.id)).bucket.reserved).toBe(BigInt(1));
  });
  it("rejects a paid reservation attached to another workspace's bucket even for the same owner", async () => {
    await makePaid(); const row = await usage(await reservation());
    await expect(sql.query(`INSERT INTO "CommercialUsageReservation" ("id","workspaceId","bucketId","resource","operationKey","amount","updatedAt") VALUES ($1,'workspace-b',$2,'DM','wrong-paid-workspace',1,NOW())`, [randomUUID(), row.bucketId])).rejects.toMatchObject({ code: "23514" });
    expect(await state.db.commercialUsageReservation.count()).toBe(1);
  });
  it("rejects mismatched bucket resources and retains a composite foreign key", async () => {
    const row = await usage(await reservation());
    await expect(sql.query(`INSERT INTO "CommercialUsageReservation" ("id","workspaceId","bucketId","resource","operationKey","amount","updatedAt") VALUES ($1,'workspace-a',$2,'PUBLICATION','wrong-resource',1,NOW())`, [randomUUID(), row.bucketId])).rejects.toMatchObject({ code: "23514" });
    const constraints = await sql.query(`SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.conrelid=$2::regclass AND c.contype='f'`, [schema, `"${schema}"."CommercialUsageReservation"`]);
    expect(constraints.rows.some(row => (row.definition as string).includes('FOREIGN KEY ("bucketId", resource)'))).toBe(true);
  });
  it("preserves unknown dispatch evidence when an accidental workspace deletion is attempted", async () => {
    const id = await reservation(), claim = await beginCommercialDispatch("workspace-a", id);
    await finishCommercialDispatch("workspace-a", id, claim!.dispatchToken, "UNKNOWN");
    await expect(sql.query(`DELETE FROM "Workspace" WHERE "id"='workspace-a'`)).rejects.toMatchObject({ code: "23001" });
    expect(await state.db.workspace.count({ where: { id: "workspace-a" } })).toBe(1);
    expect(await usage(id)).toMatchObject({ status: "DISPATCHING", dispatchToken: claim!.dispatchToken, bucket: { reserved: BigInt(1), consumed: BigInt(0) } });
  });
});
