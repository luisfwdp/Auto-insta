/** Native PostgreSQL financial/usage projections; fixture identities only.
 * No provider, customer, production or real payment request is made. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const url = process.env.TEST_DATABASE_URL, schema = `overview_${randomBytes(5).toString("hex")}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { readCommercialUsageOverview } from "../lib/billing/commercial-overview";
import { startCardFreeTrial } from "../lib/billing/trial";
import { reserveCommercialUsage, beginCommercialDispatch, finishCommercialDispatch } from "../lib/billing/commercial-usage";
import { monthlyInvoicePeriod } from "../lib/billing/financial-policy";
import { saoPauloDate } from "../lib/billing/config";
import { BILLING_PLANS } from "../lib/billing/catalog";
const scope = "10000000-0000-4000-8000-000000000001", otherScope = "20000000-0000-4000-8000-000000000002";
let sql: Client;
async function allocate(workspaceId: string, resource: "DM" | "PUBLICATION", outcome?: "CONFIRMED" | "DEFINITELY_REJECTED") {
  const reservation = await reserveCommercialUsage(workspaceId, resource, "operation_" + randomUUID());
  if (outcome) {
    const claim = await beginCommercialDispatch(workspaceId, reservation.reservationId!);
    await finishCommercialDispatch(workspaceId, reservation.reservationId!, claim!.dispatchToken, outcome);
  }
}
async function paid(workspaceId: string, futureOnly = false) {
  const planId = "pro-v1", plan = BILLING_PLANS[planId];
  const current = saoPauloDate(new Date()).slice(0, 7) + "-01", currentPeriod = monthlyInvoicePeriod(current, 1);
  const dueDate = futureOnly ? saoPauloDate(currentPeriod.endsAt) : current, period = monthlyInvoicePeriod(dueDate, 1);
  const checkout = await state.db.billingCheckout.create({ data: { workspaceId, environment: "sandbox", accountScope: scope, requestId: randomUUID(), planId, amountCents: plan.amountCents, firstChargeDate: dueDate, billingAnchorDay: 1, status: "COMPLETED", providerCheckoutId: randomUUID() } });
  const sub = await state.db.billingSubscription.create({ data: { workspaceId, environment: "sandbox", accountScope: scope, providerSubscriptionId: "sub_" + randomUUID().replaceAll("-", ""), providerCustomerId: "cus_private", checkoutId: checkout.id, planId, amountCents: plan.amountCents, billingAnchorDay: 1, renewalStatus: "ACTIVE" } });
  await state.db.billingPayment.create({ data: { workspaceId, subscriptionId: sub.id, environment: "sandbox", accountScope: scope, providerPaymentId: "pay_" + randomUUID().replaceAll("-", ""), amountCents: plan.amountCents, dueDate, status: "CONFIRMED", deleted: false } });
  await state.db.workspaceBilling.update({ where: { workspaceId }, data: { currentSubscriptionId: sub.id, status: "ACTIVE", planId, paidThrough: period.endsAt } });
  return period;
}
describe.skipIf(!url)("commercial overview native projections", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect(); await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const name of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) await sql.query(readFileSync(path.join(root, name, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5, options: `-c search_path=${schema}` }, { schema }) });
    for (const owner of ["owner-a", "owner-b", "admin-a", "member-a"]) await state.db.user.create({ data: { id: owner, email: `${owner}@example.test` } });
    for (const id of ["workspace-a", "workspace-a2", "workspace-b"]) await state.db.workspace.create({ data: { id, name: id, ownerId: id === "workspace-b" ? "owner-b" : "owner-a" } });
  });
  beforeEach(async () => {
    vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scope); vi.stubEnv("VERCEL_ENV", "test"); vi.stubEnv("FLY_APP_NAME", "local-overview-test");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Real HTTP forbidden"));
    await state.db.commercialUsageReservation.deleteMany(); await state.db.commercialUsageBucket.deleteMany();
    await state.db.workspaceMember.deleteMany();
    await state.db.workspaceBilling.updateMany({ data: { currentSubscriptionId: null } });
    await state.db.billingPayment.deleteMany(); await state.db.billingCommand.deleteMany(); await state.db.billingEvent.deleteMany(); await state.db.billingSubscription.deleteMany(); await state.db.billingCheckout.deleteMany();
    await state.db.workspaceBilling.deleteMany(); await state.db.trialRedemption.deleteMany();
    for (const id of ["workspace-a", "workspace-a2", "workspace-b"]) await startCardFreeTrial(id);
  });
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await state.db?.$disconnect(); if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });
  it("shares committed and reserved trial counts across two workspaces without leaking another owner's counts", async () => {
    await allocate("workspace-a", "DM", "CONFIRMED"); await allocate("workspace-a2", "DM");
    await allocate("workspace-a", "DM", "DEFINITELY_REJECTED"); await allocate("workspace-a2", "PUBLICATION", "CONFIRMED");
    await allocate("workspace-b", "DM", "CONFIRMED"); await allocate("workspace-b", "DM", "CONFIRMED");
    const first = await readCommercialUsageOverview("workspace-a", "owner-a"), second = await readCommercialUsageOverview("workspace-a2", "owner-a"), other = await readCommercialUsageOverview("workspace-b", "owner-b");
    expect(first).toEqual(second); expect(first.counters).toMatchObject({ dms: { consumed: 1, reserved: 1, limit: 100 }, publications: { consumed: 1, reserved: 0, limit: 10 } });
    expect(other.counters?.dms).toEqual({ consumed: 2, reserved: 0, limit: 100 });
    const text = JSON.stringify(first); for (const forbidden of ["owner-a", "workspace-a", "provider", "operation_", "dispatchToken", "receipt", "cus_private", scope]) expect(text).not.toContain(forbidden);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("isolates paid workspace counters from trial siblings and ignores incorrect provider and period buckets", async () => {
    const period = await paid("workspace-a");
    await allocate("workspace-a", "DM", "CONFIRMED"); await allocate("workspace-a", "PUBLICATION"); await allocate("workspace-a2", "DM", "CONFIRMED");
    for (const [scopeKey, periodStart, periodEnd] of [[`production:${scope}`, period.startsAt, period.endsAt], [`sandbox:${otherScope}`, period.startsAt, period.endsAt], [`sandbox:${scope}`, period.endsAt, monthlyInvoicePeriod(saoPauloDate(period.endsAt), 1).endsAt]] as const) {
      await state.db.commercialUsageBucket.create({ data: { subjectKind: "WORKSPACE_PAID", subjectId: "workspace-a", resource: "DM", scopeKey, periodStart, periodEnd, limitSnapshot: BigInt("10000"), consumed: BigInt("999"), reserved: BigInt("999") } });
    }
    const current = await readCommercialUsageOverview("workspace-a", "owner-a"), sibling = await readCommercialUsageOverview("workspace-a2", "owner-a");
    expect(current).toMatchObject({ hasAccess: true, kind: "paid", periodStart: period.startsAt.toISOString(), periodEnd: period.endsAt.toISOString(), counters: { dms: { consumed: 1, reserved: 0, limit: 10000 }, publications: { consumed: 0, reserved: 1, limit: 300 } } });
    expect(sibling).toMatchObject({ kind: "trial", counters: { dms: { consumed: 1, reserved: 0, limit: 100 } } });
  });
  it("withholds aggregate trial activity from grandfathered ADMIN/MEMBER while its real owner can read across workspaces", async () => {
    await state.db.workspaceMember.createMany({ data: [{ workspaceId: "workspace-a", userId: "admin-a", role: "ADMIN" }, { workspaceId: "workspace-a", userId: "member-a", role: "MEMBER" }] });
    await allocate("workspace-a2", "DM", "CONFIRMED"); await allocate("workspace-a2", "PUBLICATION");
    const owner = await readCommercialUsageOverview("workspace-a", "owner-a");
    expect(owner).toMatchObject({ usageVisibility: "AVAILABLE", counters: { dms: { consumed: 1, reserved: 0 }, publications: { consumed: 0, reserved: 1 } } });
    for (const viewer of ["admin-a", "member-a"]) {
      const restricted = await readCommercialUsageOverview("workspace-a", viewer);
      expect(restricted).toMatchObject({ hasAccess: true, kind: "trial", usageVisibility: "OWNER_ONLY", limits: owner.limits, counters: null });
      expect(Object.keys(restricted).sort()).toEqual(Object.keys(owner).sort());
      for (const privateValue of ["owner-a", "workspace-a2", "operation_", "reserved", "consumed"]) expect(JSON.stringify(restricted)).not.toContain(privateValue);
    }
  });
  it("allows paid workspace ADMIN/MEMBER to read only that workspace's counters", async () => {
    await paid("workspace-a");
    await state.db.workspaceMember.createMany({ data: [{ workspaceId: "workspace-a", userId: "admin-a", role: "ADMIN" }, { workspaceId: "workspace-a", userId: "member-a", role: "MEMBER" }] });
    await allocate("workspace-a", "DM", "CONFIRMED"); await allocate("workspace-a2", "DM");
    for (const viewer of ["admin-a", "member-a"]) expect(await readCommercialUsageOverview("workspace-a", viewer)).toMatchObject({ hasAccess: true, kind: "paid", usageVisibility: "AVAILABLE", counters: { dms: { consumed: 1, reserved: 0, limit: 10000 } } });
  });
  it("does not grant current access or expose future usage from a future-only payment", async () => {
    const period = await paid("workspace-a", true);
    await state.db.commercialUsageBucket.create({ data: { subjectKind: "WORKSPACE_PAID", subjectId: "workspace-a", resource: "DM", scopeKey: `sandbox:${scope}`, periodStart: period.startsAt, periodEnd: period.endsAt, limitSnapshot: BigInt("10000"), consumed: BigInt("500") } });
    expect(await readCommercialUsageOverview("workspace-a", "owner-a")).toEqual({ hasAccess: false, code: "PAYMENT_NOT_CURRENT", limits: null, counters: null });
  });
  it("does not expose historical counters after exact trial expiry", async () => {
    await allocate("workspace-a", "DM", "CONFIRMED"); const billing = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(billing.trialEndsAt);
    try { expect(await readCommercialUsageOverview("workspace-a", "owner-a")).toEqual({ hasAccess: false, code: "TRIAL_NOT_ACTIVE", limits: null, counters: null }); }
    finally { vi.useRealTimers(); }
  });
  it("fails503 when persisted BIGINT cannot be represented safely", async () => {
    await allocate("workspace-a", "DM"); await state.db.commercialUsageBucket.updateMany({ data: { consumed: BigInt(Number.MAX_SAFE_INTEGER) + BigInt("1") } });
    await expect(readCommercialUsageOverview("workspace-a", "owner-a")).rejects.toMatchObject({ code: "BILLING_UNAVAILABLE", httpStatus: 503 });
  });
});
