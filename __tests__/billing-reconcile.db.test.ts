/** Canonical financial reconciliation on PostgreSQL; gateway calls are mocked.
 * No checkout, charge, cancellation or HTTP request leaves this process.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type BillingCheckout } from "../app/generated/prisma/client";
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL, schema = `billing_reconcile_${randomBytes(5).toString("hex")}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { ingestBillingEvent } from "../lib/billing/inbox";
import { processBillingInbox, reconcileBillingResource, enqueueBillingRecovery } from "../lib/billing/reconcile";
import { claimBillingSync } from "../lib/billing/sync-lease";
import { billingStatusDTO } from "../lib/billing/trial";
import { saoPauloDate } from "../lib/billing/config";
import { monthlyInvoicePeriod } from "../lib/billing/financial-policy";
import { requestCheckout } from "../lib/billing/checkout";
import { AsaasError, type AsaasPaymentDTO, type AsaasPaymentPageDTO, type AsaasSubscriptionDTO, type createAsaasClient } from "../lib/billing/asaas-client";

type Gateway = ReturnType<typeof createAsaasClient>;
const scopeA = "d90d5756-2a22-4cda-9181-d0ccb71bf961", scopeB = "d76ae324-a78f-4baa-b8af-746d5355121d";
let sql: Client, today: string, anchor: number;
const clone = <T,>(value: T): T => structuredClone(value);
function invoiceDate(offset = 0) {
  const [year, month] = today.split("-").map(Number), first = new Date(Date.UTC(year, month - 1 + offset, 1));
  const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(anchor, end.getUTCDate())).padStart(2, "0")}`;
}
async function checkout(patch: Partial<BillingCheckout> = {}) {
  return state.db.billingCheckout.create({ data: { workspaceId: "workspace-a", environment: "sandbox", accountScope: scopeA, requestId: randomUUID(), planId: "pro-v1", amountCents: 14900,
    firstChargeDate: today, billingAnchorDay: anchor, providerCheckoutId: randomUUID(), status: "OPEN", ...patch } });
}
function payment(checkout: BillingCheckout, patch: Partial<AsaasPaymentDTO> = {}): AsaasPaymentDTO {
  return { id: "pay_current", subscription: "sub_current", customer: "cus_current", checkoutSession: checkout.providerCheckoutId, status: "CONFIRMED", valueCents: checkout.amountCents, dueDate: today, deleted: false, ...patch };
}
function subscription(checkout: BillingCheckout, patch: Partial<AsaasSubscriptionDTO> = {}): AsaasSubscriptionDTO {
  return { id: "sub_current", customer: "cus_current", checkoutSession: checkout.providerCheckoutId, status: "ACTIVE", valueCents: checkout.amountCents, cycle: "MONTHLY", deleted: false, ...patch };
}
function page(data: AsaasPaymentDTO[], patch: Partial<AsaasPaymentPageDTO> = {}): AsaasPaymentPageDTO {
  return { data: clone(data), totalCount: data.length, hasMore: false, limit: 20, offset: 0, ...patch };
}
function gateway(checkout: BillingCheckout, records = [payment(checkout)], sub = subscription(checkout)) {
  const ledger = new Map(records.map(row => [row.id, clone(row)]));
  const provider = {
    createHostedCheckout: vi.fn<Gateway["createHostedCheckout"]>().mockRejectedValue(new Error("Unexpected financial mutation")),
    cancelSubscription: vi.fn<Gateway["cancelSubscription"]>().mockRejectedValue(new Error("Unexpected financial mutation")),
    getPayment: vi.fn<Gateway["getPayment"]>(async id => { const row = ledger.get(id); if (!row) throw new AsaasError("REJECTED", 404); return clone(row); }),
    getSubscription: vi.fn<Gateway["getSubscription"]>(async () => clone(sub)),
    getPaymentLinks: vi.fn<Gateway["getPaymentLinks"]>(async id => { const row = ledger.get(id); if (!row) throw new AsaasError("REJECTED", 404); return { id: row.id, subscription: row.subscription, checkoutSession: row.checkoutSession }; }),
    getSubscriptionLinks: vi.fn<Gateway["getSubscriptionLinks"]>(async () => ({ id: sub.id, checkoutSession: sub.checkoutSession })),
    listPaymentsByCheckout: vi.fn<Gateway["listPaymentsByCheckout"]>(async () => page([...ledger.values()])),
    listPaymentsBySubscription: vi.fn<Gateway["listPaymentsBySubscription"]>(async () => page([...ledger.values()])),
  } satisfies Gateway;
  return { provider, ledger, sub };
}
async function paidState() { return state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } }); }
async function event(type: string, source: { checkoutId?: string; paymentId?: string; subscriptionId?: string }) {
  return ingestBillingEvent({ id: `evt_${randomUUID()}&123`, event: type, ...(source.checkoutId ? { checkout: { id: source.checkoutId } } : {}), ...(source.paymentId ? { payment: { id: source.paymentId } } : {}), ...(source.subscriptionId ? { subscription: { id: source.subscriptionId } } : {}) });
}
async function makeRetryDue(id: string) { await state.db.billingEvent.update({ where: { id }, data: { nextAttemptAt: new Date(0) } }); }
async function recoverySubscription(index: number, renewalStatus = "ACTIVE", paidThrough: Date | null = null) {
  const workspaceId = `workspace_recovery_${randomUUID()}`, baseline = await paidState();
  await state.db.workspace.create({ data: { id: workspaceId, name: workspaceId, ownerId: "billing-owner" } });
  await state.db.workspaceBilling.create({ data: { workspaceId, trialStartedAt: baseline.trialStartedAt, trialEndsAt: baseline.trialEndsAt } });
  const old = new Date(Date.now() - 8 * 3600000 + index * 1000);
  const link = await checkout({ workspaceId, status: "COMPLETED", createdAt: old, updatedAt: old });
  const sub = await state.db.billingSubscription.create({ data: { workspaceId, environment: "sandbox", accountScope: scopeA,
    providerSubscriptionId: `sub_recovery_${index}_${randomBytes(4).toString("hex")}`, providerCustomerId: `cus_recovery_${index}`, checkoutId: link.id,
    planId: link.planId, amountCents: link.amountCents, billingAnchorDay: anchor, renewalStatus, createdAt: old, updatedAt: old } });
  await state.db.workspaceBilling.update({ where: { workspaceId }, data: { currentSubscriptionId: sub.id, status: "PAST_DUE", paidThrough } });
  return { link, sub, workspaceId };
}

describe.skipIf(!url)("canonical billing reconciliation", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect(); await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const migrations = path.join(__dirname, "..", "prisma", "migrations");
    for (const directory of readdirSync(migrations, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort()) await sql.query(readFileSync(path.join(migrations, directory, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5, options: `-c search_path=${schema}` }, { schema }) });
    await state.db.user.create({ data: { id: "billing-owner", email: "billing-owner@example.test" } });
    await state.db.workspace.createMany({ data: ["workspace-a", "workspace-b"].map(id => ({ id, name: id, ownerId: "billing-owner" })) });
  });
  beforeEach(async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://billing-reconcile.example.test"); vi.stubEnv("AUTH_URL", undefined);
    vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scopeA); vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("FLY_APP_NAME", "");
    vi.stubEnv("BILLING_ENABLED", "false");
    await sql.query(`TRUNCATE TABLE "BillingEvent", "BillingCommand", "BillingPayment", "BillingSubscription", "BillingCheckout", "WorkspaceBilling" CASCADE`);
    const start = new Date(Date.now() - 10 * 86400000), end = new Date(start.getTime() + 3 * 86400000);
    await state.db.workspaceBilling.createMany({ data: ["workspace-a", "workspace-b"].map(workspaceId => ({ workspaceId, trialStartedAt: start, trialEndsAt: end })) });
    today = saoPauloDate(new Date()); anchor = Number(today.slice(-2));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });
  afterAll(async () => { vi.unstubAllEnvs(); await state.db?.$disconnect(); if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });

  it("does not trust CHECKOUT_PAID or ACTIVE metadata until a canonical invoice is settled", async () => {
    const link = await checkout(), fake = gateway(link, [payment(link, { status: "PENDING" })]);
    await event("CHECKOUT_PAID", { checkoutId: link.providerCheckoutId! });
    expect(await processBillingInbox(5, fake.provider)).toEqual({ processed: 1 });
    expect(billingStatusDTO(await paidState()).hasAccess).toBe(false);
    expect((await paidState()).status).toBe("PAST_DUE");
    fake.ledger.set("pay_current", payment(link, { status: "CONFIRMED" }));
    await event("PAYMENT_CONFIRMED", { paymentId: "pay_current" }); await processBillingInbox(5, fake.provider);
    expect(billingStatusDTO(await paidState()).hasAccess).toBe(true);
    expect(fake.provider.createHostedCheckout).not.toHaveBeenCalled(); expect(fake.provider.cancelSubscription).not.toHaveBeenCalled();
  });
  it("coalesces canonical CONFIRMED/RECEIVED and repeated event deliveries into one invoice interval", async () => {
    const link = await checkout(), fake = gateway(link);
    await event("PAYMENT_CONFIRMED", { paymentId: "pay_current" }); await processBillingInbox(5, fake.provider);
    const first = await paidState();
    fake.ledger.set("pay_current", payment(link, { status: "RECEIVED" }));
    const envelope = { id: "evt_duplicate&19", event: "PAYMENT_RECEIVED", payment: { id: "pay_current" } };
    await Promise.all(Array.from({ length: 10 }, () => ingestBillingEvent(envelope))); await processBillingInbox(5, fake.provider);
    expect(await state.db.billingPayment.count()).toBe(1);
    expect((await paidState()).paidThrough).toEqual(first.paidThrough);
    expect(first.paidThrough).toEqual(monthlyInvoicePeriod(today, anchor).endsAt);
  });
  it("uses all canonical pages without adding periods for distinct IDs in the same paid interval", async () => {
    const link = await checkout(), records = Array.from({ length: 21 }, (_, i) => payment(link, { id: `pay_page_${i}` })), fake = gateway(link, [records[0]]);
    fake.provider.listPaymentsBySubscription.mockImplementation(async (_id, options) => page(records.slice(options?.offset ?? 0, (options?.offset ?? 0) + 20), { totalCount: 21, hasMore: !options?.offset, offset: options?.offset ?? 0 }));
    await reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider);
    expect(fake.provider.listPaymentsBySubscription).toHaveBeenCalledTimes(4);
    expect(await state.db.billingPayment.count()).toBe(21); expect((await paidState()).paidThrough).toEqual(monthlyInvoicePeriod(today, anchor).endsAt);
  });
  it("rejects a canonical page error before writing bindings or granting access", async () => {
    const link = await checkout(), fake = gateway(link);
    fake.provider.listPaymentsBySubscription.mockRejectedValue(new AsaasError("INVALID_RESPONSE"));
    await event("CHECKOUT_PAID", { checkoutId: link.providerCheckoutId! }); await processBillingInbox(5, fake.provider);
    expect(await state.db.billingSubscription.count()).toBe(0); expect(billingStatusDTO(await paidState()).hasAccess).toBe(false);
    expect(await state.db.billingEvent.findFirstOrThrow()).toMatchObject({ status: "RETRY", lastErrorCode: "INVALID_RESPONSE" });
  });
  it("does not accept a self-contradictory totalCount as a complete canonical ledger", async () => {
    const link = await checkout(), fake = gateway(link);
    fake.provider.listPaymentsBySubscription.mockResolvedValue(page([payment(link)], { totalCount: 2, hasMore: false }));
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toMatchObject({ code: "PAGINATION_INVALID" });
    expect(await state.db.billingSubscription.count()).toBe(0); expect(billingStatusDTO(await paidState()).hasAccess).toBe(false);
  });
  it("rejects duplicate payment IDs inside one canonical traversal even when their settled values agree", async () => {
    const link = await checkout(), fake = gateway(link);
    fake.provider.listPaymentsBySubscription.mockResolvedValue(page([payment(link), payment(link)]));
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toMatchObject({ code: "PAGINATION_INVALID" });
    expect(await state.db.billingPayment.count()).toBe(0); expect((await paidState()).currentSubscriptionId).toBeNull();
  });
  it("rejects hasMore when the reported ledger total is already exhausted", async () => {
    const link = await checkout(), fake = gateway(link);
    fake.provider.listPaymentsBySubscription.mockResolvedValue(page([payment(link)], { hasMore: true }));
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toMatchObject({ code: "PAGINATION_INVALID" });
    expect(fake.provider.listPaymentsBySubscription).toHaveBeenCalledOnce(); expect(await state.db.billingSubscription.count()).toBe(0);
  });
  it("rejects a totalCount that changes across otherwise consistent canonical pages", async () => {
    const link = await checkout(), rows = Array.from({ length: 21 }, (_, index) => payment(link, { id: `pay_drift_${index}` })), fake = gateway(link, [rows[0]]);
    fake.provider.listPaymentsBySubscription.mockImplementation(async (_id, options) => options?.offset
      ? page(rows.slice(20), { offset: 20, totalCount: 21 })
      : page(rows.slice(0, 20), { totalCount: 22, hasMore: true }));
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toMatchObject({ code: "PAGINATION_INVALID" });
    expect(fake.provider.listPaymentsBySubscription).toHaveBeenCalledTimes(2); expect(await state.db.billingPayment.count()).toBe(0); expect(billingStatusDTO(await paidState()).hasAccess).toBe(false);
  });
  it("bounds pagination at ten pages and retains the durable event for retry", async () => {
    const link = await checkout(), fake = gateway(link);
    fake.provider.listPaymentsBySubscription.mockImplementation(async (_id, options) => page([payment(link, { id: `pay_page_${options?.offset ?? 0}` })], { offset: options?.offset ?? 0, totalCount: 11, hasMore: true }));
    await event("CHECKOUT_PAID", { checkoutId: link.providerCheckoutId! }); await processBillingInbox(5, fake.provider);
    expect(fake.provider.listPaymentsBySubscription).toHaveBeenCalledTimes(10);
    expect(await state.db.billingPayment.count()).toBe(0); expect((await paidState()).currentSubscriptionId).toBeNull();
    expect(await state.db.billingEvent.findFirstOrThrow()).toMatchObject({ status: "RETRY", lastErrorCode: "LEDGER_TOO_LARGE" });
  });
  it.each([
    ["customer", { customer: "cus_other" }], ["subscription", { subscription: "sub_other" }], ["amount", { valueCents: 14901 }],
    ["checkout", { checkoutSession: randomUUID() }], ["anchor", { dueDate: "2027-01-01" }],
  ] as const)("fails closed on canonical payment %s mismatch", async (_name, patch) => {
    const mismatch = _name === "anchor" ? { ...patch, dueDate: `2027-01-${anchor === 1 ? "02" : "01"}` } : patch;
    const link = await checkout(), fake = gateway(link, [payment(link, mismatch)]);
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toBeDefined();
    expect(await state.db.billingPayment.count()).toBe(0); expect((await paidState()).currentSubscriptionId).toBeNull();
  });
  it.each([{ cycle: "YEARLY" as const }, { valueCents: 14901 }])("fails closed on canonical subscription quote mismatch %#", async patch => {
    const link = await checkout(), fake = gateway(link, [payment(link)], subscription(link, patch));
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toMatchObject({ code: "CANONICAL_LINK_MISMATCH" });
    expect(billingStatusDTO(await paidState()).hasAccess).toBe(false);
  });
  it.each(["scope", "environment"])("does not find a binding in another configured %s", async kind => {
    const link = await checkout(), fake = gateway(link);
    vi.stubEnv(kind === "scope" ? "ASAAS_ACCOUNT_SCOPE" : "ASAAS_ENVIRONMENT", kind === "scope" ? scopeB : "production");
    await expect(reconcileBillingResource({ paymentId: "pay_current" }, fake.provider)).rejects.toMatchObject({ code: "RESOURCE_NOT_BOUND" });
    expect((await paidState()).currentSubscriptionId).toBeNull(); expect(await state.db.billingPayment.count()).toBe(0);
  });
  it("rolls back a stale sync owner after a replacement obtains its lease", async () => {
    const link = await checkout(), fake = gateway(link); let replacement = "";
    fake.provider.listPaymentsBySubscription.mockImplementationOnce(async () => {
      await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { syncLeaseUntil: new Date(0) } });
      replacement = await claimBillingSync("workspace-a"); return page([payment(link)]);
    });
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toMatchObject({ code: "SYNC_LEASE_LOST" });
    expect(await state.db.billingSubscription.count()).toBe(0); expect(await state.db.billingPayment.count()).toBe(0);
    expect((await paidState()).syncLeaseToken).toBe(replacement); expect((await paidState()).currentSubscriptionId).toBeNull();
  });
  it("renews the sync lease around each timely API read when the full traversal exceeds 180 seconds", async () => {
    const link = await checkout(), fake = gateway(link), started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    const advance = () => vi.setSystemTime(Date.now() + 120000);
    fake.provider.listPaymentsByCheckout.mockImplementation(async () => { advance(); return page([payment(link)]); });
    fake.provider.getSubscription.mockImplementation(async () => { advance(); return clone(fake.sub); });
    fake.provider.listPaymentsBySubscription.mockImplementation(async () => { advance(); return page([payment(link)]); });
    await reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider);
    expect(Date.now() - started).toBeGreaterThan(180000); expect(billingStatusDTO(await paidState()).hasAccess).toBe(true);
    expect((await paidState()).syncLeaseToken).toBeNull();
  });
  it("claims each queued event only when processing starts so a long first reconciliation cannot age the second lease", async () => {
    const link = await checkout(), fake = gateway(link);
    const first = await event("CHECKOUT_PAID", { checkoutId: link.providerCheckoutId! });
    const second = await event("CHECKOUT_PAID", { checkoutId: link.providerCheckoutId! });
    const ids = [first.id, second.id], started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    const advance = () => vi.setSystemTime(Date.now() + 120000);
    let firstRead = true, secondClaimObserved = false;
    fake.provider.listPaymentsByCheckout.mockImplementation(async () => {
      if (firstRead) {
        firstRead = false;
        const rows = await state.db.billingEvent.findMany({ where: { id: { in: ids } } });
        expect(rows.filter(row => row.status === "PROCESSING")).toHaveLength(1);
        expect(rows.filter(row => row.status === "PENDING" && row.attempts === 0)).toHaveLength(1);
      }
      advance(); return page([payment(link)]);
    });
    fake.provider.getSubscription.mockImplementation(async () => {
      const rows = await state.db.billingEvent.findMany({ where: { id: { in: ids } } });
      if (rows.some(row => row.status === "PROCESSED")) {
        secondClaimObserved = true;
        expect(rows.filter(row => row.status === "PROCESSING" && row.attempts === 1)).toHaveLength(1);
      }
      advance(); return clone(fake.sub);
    });
    fake.provider.listPaymentsBySubscription.mockImplementation(async () => { advance(); return page([payment(link)]); });
    expect(await processBillingInbox(2, fake.provider)).toEqual({ processed: 2 });
    expect(Date.now() - started).toBeGreaterThan(180000); expect(secondClaimObserved).toBe(true);
    const rows = await state.db.billingEvent.findMany({ where: { id: { in: ids } } });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ status: "PROCESSED", attempts: 1, leaseToken: null, leaseUntil: null });
    expect(await state.db.billingPayment.count()).toBe(1); expect(billingStatusDTO(await paidState()).hasAccess).toBe(true);
    expect(fake.provider.createHostedCheckout).not.toHaveBeenCalled(); expect(fake.provider.cancelSubscription).not.toHaveBeenCalled();
  });
  it("never revives a lease whose single API read reached the 180-second deadline", async () => {
    const link = await checkout(), fake = gateway(link), started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    fake.provider.listPaymentsByCheckout.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 180000); return page([payment(link)]); });
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toMatchObject({ code: "SYNC_LEASE_LOST" });
    expect(await state.db.billingPayment.count()).toBe(0); expect((await paidState()).currentSubscriptionId).toBeNull();
  });
  it("does not let a failed canonical API read discard an already persisted event", async () => {
    const link = await checkout(), fake = gateway(link); fake.provider.getSubscription.mockRejectedValueOnce(new AsaasError("UNAVAILABLE"));
    const item = await event("CHECKOUT_PAID", { checkoutId: link.providerCheckoutId! });
    await processBillingInbox(5, fake.provider);
    expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "UNAVAILABLE", attempts: 1 });
    expect((await paidState()).syncLeaseToken).toBeNull();
    await makeRetryDue(item.id); expect(await processBillingInbox(5, fake.provider)).toEqual({ processed: 1 });
    expect(billingStatusDTO(await paidState()).hasAccess).toBe(true);
  });
  it("waits for a provider checkout ID persisted after the webhook without creating a second checkout", async () => {
    const providerId = randomUUID(), link = await checkout({ providerCheckoutId: null, status: "CREATING" }), fake = gateway({ ...link, providerCheckoutId: providerId });
    const item = await event("CHECKOUT_PAID", { checkoutId: providerId }); await processBillingInbox(5, fake.provider);
    expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "RESOURCE_NOT_BOUND" });
    await state.db.billingCheckout.update({ where: { id: link.id }, data: { providerCheckoutId: providerId, status: "OPEN" } });
    await makeRetryDue(item.id); await processBillingInbox(5, fake.provider);
    expect(await state.db.billingCheckout.count()).toBe(1); expect(billingStatusDTO(await paidState()).hasAccess).toBe(true); expect(fake.provider.createHostedCheckout).not.toHaveBeenCalled();
  });
  describe("events from other products sharing the Asaas account", () => {
    const foreign = (link: BillingCheckout) => payment(link, { id: "pay_foreign", subscription: "sub_foreign", customer: "cus_foreign", checkoutSession: randomUUID() });
    // BillingEvent.createdAt is immutable in SQL, so the clock moves forward instead.
    async function age(id: string, ms = 10 * 60_000) { await makeRetryDue(id); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + ms); }
    async function untouched() {
      expect(await state.db.billingPayment.count()).toBe(0); expect(await state.db.billingSubscription.count()).toBe(0);
      expect((await paidState()).currentSubscriptionId).toBeNull(); expect(billingStatusDTO(await paidState()).hasAccess).toBe(false);
    }

    it("finishes an unbound provider event as FOREIGN_RESOURCE instead of dead-lettering it, even on its last attempt", async () => {
      const own = await checkout(), fake = gateway(own, [foreign(own)]);
      const item = await event("PAYMENT_RECEIVED", { paymentId: "pay_foreign" });
      await age(item.id); await state.db.billingEvent.update({ where: { id: item.id }, data: { attempts: 11 } });
      expect(await processBillingInbox(5, fake.provider)).toEqual({ processed: 1 });
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "PROCESSED", lastErrorCode: "FOREIGN_RESOURCE", attempts: 12, leaseToken: null });
      expect(await state.db.billingEvent.count({ where: { status: "DEAD" } })).toBe(0);
      expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: own.id } })).status).toBe("OPEN");
      await untouched(); expect(fake.provider.createHostedCheckout).not.toHaveBeenCalled();
    });
    it.each([
      ["SUBSCRIPTION_CREATED", { subscriptionId: "sub_foreign" }],
      ["CHECKOUT_PAID", { checkoutId: randomUUID() }],
    ] as const)("classifies a foreign %s the same way", async (type, source) => {
      const own = await checkout(), fake = gateway(own, [foreign(own)], subscription(own, { id: "sub_foreign", customer: "cus_foreign", checkoutSession: randomUUID() }));
      const item = await event(type, source); await age(item.id);
      await processBillingInbox(5, fake.provider);
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "PROCESSED", lastErrorCode: "FOREIGN_RESOURCE" });
      await untouched();
    });
    it("classifies a foreign payment or subscription whose full state our strict schema rejects", async () => {
      const own = await checkout(), fake = gateway(own, [foreign(own)], subscription(own, { id: "sub_foreign", customer: "cus_foreign", checkoutSession: randomUUID() }));
      fake.provider.getPayment.mockRejectedValue(new AsaasError("INVALID_RESPONSE")); fake.provider.getSubscription.mockRejectedValue(new AsaasError("INVALID_RESPONSE"));
      const paid = await event("PAYMENT_RECEIVED", { paymentId: "pay_foreign" }), created = await event("SUBSCRIPTION_CREATED", { subscriptionId: "sub_foreign" });
      await makeRetryDue(created.id); await age(paid.id);
      expect(await processBillingInbox(5, fake.provider)).toEqual({ processed: 2 });
      for (const id of [paid.id, created.id]) expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PROCESSED", lastErrorCode: "FOREIGN_RESOURCE" });
      expect(fake.provider.getPayment).not.toHaveBeenCalled(); expect(fake.provider.getSubscription).not.toHaveBeenCalled();
      await untouched();
    });
    it("still fails closed when our own bound payment has a state the strict schema rejects", async () => {
      const link = await checkout(), fake = gateway(link); fake.provider.getPayment.mockRejectedValue(new AsaasError("INVALID_RESPONSE"));
      const item = await event("PAYMENT_CONFIRMED", { paymentId: "pay_current" }); await age(item.id);
      await processBillingInbox(5, fake.provider);
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "INVALID_RESPONSE" });
      expect(fake.provider.getPayment).toHaveBeenCalledWith("pay_current"); await untouched();
    });
    it("classifies a foreign payment or subscription that the provider no longer finds (404)", async () => {
      const own = await checkout(), fake = gateway(own, [foreign(own)]);
      fake.provider.getSubscriptionLinks.mockRejectedValue(new AsaasError("REJECTED", 404));
      const gone = await event("PAYMENT_DELETED", { paymentId: "pay_gone" }), sub = await event("SUBSCRIPTION_DELETED", { subscriptionId: "sub_gone" });
      await makeRetryDue(sub.id); await age(gone.id);
      expect(await processBillingInbox(5, fake.provider)).toEqual({ processed: 2 });
      for (const id of [gone.id, sub.id]) expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PROCESSED", lastErrorCode: "FOREIGN_RESOURCE" });
      await untouched();
    });
    it("keeps the provider REJECTED code while a 404 event is inside the grace period", async () => {
      const own = await checkout(), fake = gateway(own);
      const item = await event("PAYMENT_DELETED", { paymentId: "pay_gone" });
      await processBillingInbox(5, fake.provider);
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "REJECTED" });
    });
    it("keeps retrying a 404 for our own payment identified by the webhook payload", async () => {
      const link = await checkout(), fake = gateway(link, []);
      const item = await ingestBillingEvent({ id: `evt_${randomUUID()}`, event: "PAYMENT_DELETED", payment: { id: "pay_current", subscription: "sub_current", checkoutSession: link.providerCheckoutId } });
      await age(item.id);
      await processBillingInbox(5, fake.provider);
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "REJECTED" });
    });
    it.each([400, 401, 403])("never classifies a provider HTTP %s as foreign", async status => {
      const own = await checkout(), fake = gateway(own, [foreign(own)]);
      fake.provider.getPaymentLinks.mockRejectedValue(new AsaasError("REJECTED", status));
      const item = await event("PAYMENT_RECEIVED", { paymentId: "pay_foreign" }); await age(item.id);
      await processBillingInbox(5, fake.provider);
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "REJECTED" });
    });
    it("keeps retrying an unbound event during the grace period", async () => {
      const own = await checkout(), fake = gateway(own, [foreign(own)]);
      const item = await event("PAYMENT_RECEIVED", { paymentId: "pay_foreign" });
      await processBillingInbox(5, fake.provider);
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "RESOURCE_NOT_BOUND" });
    });
    it.each(["CREATING", "UNKNOWN"] as const)("keeps reprocessing our own early webhook while a %s intent has no provider ID", async status => {
      const providerId = randomUUID(), link = await checkout({ providerCheckoutId: null, status }), fake = gateway({ ...link, providerCheckoutId: providerId });
      const item = await event("CHECKOUT_PAID", { checkoutId: providerId }); await age(item.id, 30 * 60_000);
      await processBillingInbox(5, fake.provider);
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "RESOURCE_NOT_BOUND" });
      vi.useRealTimers(); await state.db.billingCheckout.update({ where: { id: link.id }, data: { providerCheckoutId: providerId, status: "OPEN" } });
      await makeRetryDue(item.id); expect(await processBillingInbox(5, fake.provider)).toEqual({ processed: 1 });
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "PROCESSED", lastErrorCode: null });
      expect(billingStatusDTO(await paidState()).hasAccess).toBe(true); expect(fake.provider.createHostedCheckout).not.toHaveBeenCalled();
    });
    it("does not let an intent created after the event was received block the classification", async () => {
      const own = await checkout(), fake = gateway(own, [foreign(own)]);
      const item = await event("PAYMENT_RECEIVED", { paymentId: "pay_foreign" }); await age(item.id, 30 * 60_000);
      await checkout({ workspaceId: "workspace-b", providerCheckoutId: null, status: "UNKNOWN", createdAt: new Date() });
      await processBillingInbox(5, fake.provider);
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "PROCESSED", lastErrorCode: "FOREIGN_RESOURCE" });
    });
    it("honors our checkout ID from the webhook payload even when the canonical GET has not linked it yet", async () => {
      const link = await checkout(), fake = gateway(link, [payment(link, { subscription: null, checkoutSession: null })]);
      const item = await ingestBillingEvent({ id: `evt_${randomUUID()}`, event: "PAYMENT_CONFIRMED", payment: { id: "pay_current", subscription: "sub_current", checkoutSession: link.providerCheckoutId } });
      await age(item.id);
      await processBillingInbox(5, fake.provider);
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "RESOURCE_NOT_BOUND" });
    });
    it("never classifies internal recovery work as foreign", async () => {
      const own = await checkout(), fake = gateway(own, [foreign(own)], subscription(own, { id: "sub_unbound", customer: "cus_foreign", checkoutSession: randomUUID() }));
      const item = await state.db.billingEvent.create({ data: { environment: "sandbox", accountScope: scopeA, eventId: `recovery-sub:${randomUUID()}:1`, eventType: "INTERNAL_SUBSCRIPTION_RECONCILE", subscriptionId: "sub_unbound" } });
      await age(item.id);
      await processBillingInbox(5, fake.provider);
      expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "RESOURCE_NOT_BOUND" });
    });
  });
  it("rolls back all financial effects on a native database failure and retries the durable event", async () => {
    const link = await checkout(), fake = gateway(link), item = await event("CHECKOUT_PAID", { checkoutId: link.providerCheckoutId! });
    await sql.query(`CREATE FUNCTION reconciliation_test_failure() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only failure'; END $$`);
    await sql.query(`CREATE TRIGGER reconciliation_test_failure BEFORE INSERT ON "BillingPayment" FOR EACH ROW EXECUTE FUNCTION reconciliation_test_failure()`);
    try { await processBillingInbox(5, fake.provider); } finally { await sql.query(`DROP TRIGGER reconciliation_test_failure ON "BillingPayment"`); await sql.query(`DROP FUNCTION reconciliation_test_failure()`); }
    expect(await state.db.billingSubscription.count()).toBe(0); expect(await state.db.billingPayment.count()).toBe(0);
    expect((await paidState()).currentSubscriptionId).toBeNull(); expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("OPEN");
    expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "RECONCILIATION_UNAVAILABLE" });
    await makeRetryDue(item.id); await processBillingInbox(5, fake.provider);
    expect(await state.db.billingPayment.count()).toBe(1); expect(billingStatusDTO(await paidState()).hasAccess).toBe(true);
  });
  it("preserves suspension even when the canonical current invoice is paid", async () => {
    const link = await checkout(), fake = gateway(link);
    await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { status: "SUSPENDED" } });
    await reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider);
    expect((await paidState()).status).toBe("SUSPENDED"); expect(billingStatusDTO(await paidState()).hasAccess).toBe(false);
  });
  it("old overdue/refund events do not revoke a newer settled invoice, but refunding the current one does", async () => {
    const link = await checkout(), old = payment(link, { id: "pay_old", dueDate: invoiceDate(-1), status: "OVERDUE" }), fake = gateway(link, [old, payment(link)]);
    await reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider); const first = await paidState();
    fake.ledger.set(old.id, { ...old, status: "REFUNDED" });
    await event("PAYMENT_REFUNDED", { paymentId: old.id }); await processBillingInbox(5, fake.provider);
    expect((await paidState()).paidThrough).toEqual(first.paidThrough); expect(billingStatusDTO(await paidState()).hasAccess).toBe(true);
    fake.ledger.set("pay_current", payment(link, { status: "REFUNDED" }));
    await event("PAYMENT_REFUNDED", { paymentId: "pay_current" }); await processBillingInbox(5, fake.provider);
    expect(billingStatusDTO(await paidState()).hasAccess).toBe(false); expect((await paidState()).paidThrough).toBeNull();
  });
  it("ACTIVE/canceled recurrence metadata without a settled invoice does not grant access", async () => {
    const link = await checkout(), fake = gateway(link, [payment(link, { status: "PENDING" })], subscription(link, { status: "INACTIVE", deleted: true }));
    await reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider);
    expect((await paidState()).status).toBe("CANCELED"); expect(billingStatusDTO(await paidState()).hasAccess).toBe(false);
  });
  it("fetches a known invoice omitted from a paginated list before revoking its period", async () => {
    const link = await checkout(), fake = gateway(link); await reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider);
    fake.ledger.set("pay_current", payment(link, { status: "REFUNDED", deleted: true })); fake.provider.listPaymentsBySubscription.mockResolvedValue(page([]));
    fake.provider.getPayment.mockClear(); await reconcileBillingResource({ subscriptionId: "sub_current" }, fake.provider);
    expect(fake.provider.getPayment).toHaveBeenCalledExactlyOnceWith("pay_current"); expect(billingStatusDTO(await paidState()).hasAccess).toBe(false);
    expect(await state.db.billingPayment.findFirstOrThrow()).toMatchObject({ status: "REFUNDED", deleted: true });
  });
  it("rejects inconsistent checkout and subscription snapshots instead of choosing event arrival order", async () => {
    const link = await checkout(), fake = gateway(link);
    fake.provider.listPaymentsBySubscription.mockResolvedValue(page([payment(link, { status: "REFUNDED" })]));
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(await state.db.billingPayment.count()).toBe(0); expect(billingStatusDTO(await paidState()).hasAccess).toBe(false);
  });
  it("never overwrites an immutable stored invoice date when the canonical API changes it", async () => {
    const link = await checkout(), fake = gateway(link); await reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider);
    const initial = await paidState(); fake.ledger.set("pay_current", payment(link, { dueDate: invoiceDate(1) }));
    await expect(reconcileBillingResource({ subscriptionId: "sub_current" }, fake.provider)).rejects.toMatchObject({ code: "CANONICAL_INVOICE_CHANGED" });
    expect((await state.db.billingPayment.findFirstOrThrow()).dueDate).toBe(today); expect((await paidState()).paidThrough).toEqual(initial.paidThrough);
  });
  it("a late event for an older subscription never replaces the newer current pointer", async () => {
    const oldLink = await checkout({ createdAt: new Date(Date.now() - 2 * 86400000) }), oldPayment = payment(oldLink, { id: "pay_old", subscription: "sub_old", dueDate: invoiceDate(-1) });
    const old = gateway(oldLink, [oldPayment], subscription(oldLink, { id: "sub_old", status: "INACTIVE", deleted: true }));
    await reconcileBillingResource({ checkoutId: oldLink.providerCheckoutId! }, old.provider);
    const nextLink = await checkout(), current = gateway(nextLink); await reconcileBillingResource({ checkoutId: nextLink.providerCheckoutId! }, current.provider);
    const initial = await paidState(); old.ledger.set(oldPayment.id, { ...oldPayment, status: "REFUNDED" });
    await event("PAYMENT_REFUNDED", { paymentId: oldPayment.id }); await processBillingInbox(5, old.provider);
    expect((await paidState()).currentSubscriptionId).toBe(initial.currentSubscriptionId); expect((await paidState()).paidThrough).toEqual(initial.paidThrough); expect(billingStatusDTO(await paidState()).hasAccess).toBe(true);
  });
  it.each(["renewal-active", "paid-current-period"])("alerts durably instead of silently accepting a noncurrent older subscription with %s", async reason => {
    const oldLink = await checkout({ createdAt: new Date(Date.now() - 2 * 86400000) }), oldPayment = payment(oldLink, { id: "pay_old_historical", subscription: "sub_old", dueDate: invoiceDate(-1) });
    const old = gateway(oldLink, [oldPayment], subscription(oldLink, { id: "sub_old", status: "INACTIVE", deleted: true }));
    await reconcileBillingResource({ checkoutId: oldLink.providerCheckoutId! }, old.provider);
    const nextLink = await checkout(), current = gateway(nextLink); await reconcileBillingResource({ checkoutId: nextLink.providerCheckoutId! }, current.provider);
    const initial = await paidState();
    if (reason === "renewal-active") { old.sub.status = "ACTIVE"; old.sub.deleted = false; }
    else old.ledger.set("pay_old_late", payment(oldLink, { id: "pay_old_late", subscription: "sub_old" }));
    const item = await event("SUBSCRIPTION_UPDATED", { subscriptionId: "sub_old" });
    await state.db.billingEvent.update({ where: { id: item.id }, data: { attempts: 11 } });
    await processBillingInbox(5, old.provider);
    expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "DEAD", lastErrorCode: "MULTIPLE_SUBSCRIPTIONS_REVIEW_REQUIRED", attempts: 12 });
    expect((await paidState()).currentSubscriptionId).toBe(initial.currentSubscriptionId); expect((await paidState()).paidThrough).toEqual(initial.paidThrough);
    expect(old.provider.createHostedCheckout).not.toHaveBeenCalled(); expect(old.provider.cancelSubscription).not.toHaveBeenCalled();
  });
  it("rejects a same-total invoice ID swap between the two canonical validation traversals", async () => {
    const link = await checkout(), records = Array.from({ length: 21 }, (_, index) => payment(link, { id: `pay_stable_${index}` })), fake = gateway(link, [records[0]]);
    let pass = 0;
    fake.provider.listPaymentsBySubscription.mockImplementation(async (_id, options) => {
      const offset = options?.offset ?? 0; if (!offset) pass++;
      const current = pass === 1 ? records : [...records.slice(0, 20), payment(link, { id: "pay_swapped_same_total" })];
      return page(current.slice(offset, offset + 20), { offset, totalCount: 21, hasMore: offset === 0 });
    });
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toMatchObject({ code: "PAGINATION_INVALID" });
    expect(pass).toBe(2); expect(await state.db.billingPayment.count()).toBe(0); expect((await paidState()).currentSubscriptionId).toBeNull();
  });
  it.each(["CHECKOUT_EXPIRED", "CHECKOUT_CANCELED"])("only releases an old empty checkout after authenticated terminal %s evidence", async type => {
    const link = await checkout({ createdAt: new Date(Date.now() - 70 * 60000) }), fake = gateway(link, []);
    await expect(reconcileBillingResource({ checkoutId: link.providerCheckoutId! }, fake.provider)).rejects.toMatchObject({ code: "PAYMENT_NOT_VISIBLE" });
    expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("OPEN");
    await event(type, { checkoutId: link.providerCheckoutId! }); await processBillingInbox(5, fake.provider);
    expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).status).toBe(type === "CHECKOUT_EXPIRED" ? "EXPIRED" : "CANCELED");
    expect(billingStatusDTO(await paidState()).hasAccess).toBe(false); expect(fake.provider.createHostedCheckout).not.toHaveBeenCalled();
  });
  it("does not close a recently created link merely because a terminal event arrived before canonical indexing", async () => {
    const link = await checkout({ createdAt: new Date(Date.now() - 64 * 60000) }), fake = gateway(link, []);
    await event("CHECKOUT_EXPIRED", { checkoutId: link.providerCheckoutId! }); await processBillingInbox(5, fake.provider);
    expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("OPEN");
    expect(await state.db.billingEvent.findFirstOrThrow()).toMatchObject({ status: "RETRY", lastErrorCode: "PAYMENT_NOT_VISIBLE" });
  });
  it("recovers an expired known OPEN link without a terminal webhook and allows a new explicit checkout", async () => {
    const past = new Date(Date.now() - 7 * 3600000), link = await checkout({ createdAt: past, updatedAt: past, checkoutUrlCiphertext: "fake-encrypted-known-link" }), fake = gateway(link, []);
    expect(await enqueueBillingRecovery()).toMatchObject({ count: 1 }); expect(await enqueueBillingRecovery()).toMatchObject({ count: 0 });
    expect(await state.db.billingEvent.findFirstOrThrow()).toMatchObject({ eventType: "INTERNAL_CHECKOUT_RECONCILE", checkoutId: link.providerCheckoutId });
    await processBillingInbox(5, fake.provider);
    expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("EXPIRED"); expect(fake.provider.createHostedCheckout).not.toHaveBeenCalled();
    vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const nextId = randomUUID(); fake.provider.createHostedCheckout.mockResolvedValueOnce({ id: nextId, url: `https://sandbox.asaas.com/checkoutSession/show?id=${nextId}` });
    expect(await requestCheckout("workspace-a", { requestId: randomUUID(), planId: "pro-v1", expectedAmountCents: 14900, acceptImmediateCharge: true }, fake.provider)).toMatchObject({ status: "OPEN" });
    expect(fake.provider.createHostedCheckout).toHaveBeenCalledOnce(); expect(await state.db.billingCheckout.count()).toBe(2);
  });
  it("leaves an old UNKNOWN creation operator-gated after empty canonical recovery", async () => {
    const past = new Date(Date.now() - 7 * 3600000), link = await checkout({ status: "UNKNOWN", createdAt: past, updatedAt: past }), fake = gateway(link, []);
    await enqueueBillingRecovery(); await processBillingInbox(5, fake.provider);
    expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("UNKNOWN");
    vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(await requestCheckout("workspace-a", { requestId: randomUUID(), planId: "pro-v1", expectedAmountCents: 14900, acceptImmediateCharge: true }, fake.provider)).toMatchObject({ status: "UNKNOWN" });
    expect(fake.provider.createHostedCheckout).not.toHaveBeenCalled(); expect(await state.db.billingCheckout.count()).toBe(1);
  });
  it("does not expire a link with durable CHECKOUT_PAID evidence even when internal recovery sees no canonical invoices", async () => {
    const past = new Date(Date.now() - 7 * 3600000), link = await checkout({ createdAt: past, updatedAt: past }), fake = gateway(link, []);
    const paid = await event("CHECKOUT_PAID", { checkoutId: link.providerCheckoutId! }); await processBillingInbox(5, fake.provider);
    expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: paid.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "PAYMENT_NOT_VISIBLE" });
    expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("OPEN");
    await enqueueBillingRecovery(); await processBillingInbox(5, fake.provider);
    expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("OPEN");
    expect(fake.provider.createHostedCheckout).not.toHaveBeenCalled();
  });
  it("rotates recovery past three older failed subscriptions so a newer healthy one is reconciled", async () => {
    const cohort = [];
    for (let index = 0; index < 4; index++) cohort.push(await recoverySubscription(index));
    const healthy = cohort[3], record = payment(healthy.link, { id: "pay_recovery_healthy", subscription: healthy.sub.providerSubscriptionId, customer: healthy.sub.providerCustomerId });
    const fake = gateway(healthy.link, [record], subscription(healthy.link, { id: healthy.sub.providerSubscriptionId, customer: healthy.sub.providerCustomerId }));
    fake.provider.getSubscription.mockImplementation(async id => {
      if (id !== healthy.sub.providerSubscriptionId) throw new AsaasError("UNAVAILABLE");
      return clone(fake.sub);
    });
    expect(await enqueueBillingRecovery()).toMatchObject({ count: 2 }); await processBillingInbox(5, fake.provider);
    const first = await state.db.billingSubscription.findMany({ where: { id: { in: cohort.map(row => row.sub.id) } } });
    expect(first.filter(row => row.recoveryEnqueuedAt !== null)).toHaveLength(2);
    expect(await enqueueBillingRecovery()).toMatchObject({ count: 2 }); await processBillingInbox(5, fake.provider);
    const healthyBilling = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: healthy.workspaceId } });
    expect(billingStatusDTO(healthyBilling).hasAccess).toBe(true);
    expect(await state.db.billingEvent.findFirstOrThrow({ where: { subscriptionId: healthy.sub.providerSubscriptionId } })).toMatchObject({ status: "PROCESSED" });
    expect(await state.db.billingEvent.count({ where: { status: "RETRY", lastErrorCode: "UNAVAILABLE" } })).toBe(3);
    expect(await enqueueBillingRecovery()).toMatchObject({ count: 0 });
    expect(fake.provider.createHostedCheckout).not.toHaveBeenCalled();
  });
  it("enqueues one checkout and two subscriptions at most per recovery tick", async () => {
    await recoverySubscription(0); await recoverySubscription(1); await recoverySubscription(2);
    const past = new Date(Date.now() - 8 * 3600000);
    await checkout({ createdAt: past, updatedAt: past });
    await checkout({ workspaceId: "workspace-b", createdAt: past, updatedAt: past });
    expect(await enqueueBillingRecovery()).toMatchObject({ count: 3 });
    expect(await state.db.billingEvent.count({ where: { eventType: "INTERNAL_SUBSCRIPTION_RECONCILE" } })).toBe(2);
    expect(await state.db.billingEvent.count({ where: { eventType: "INTERNAL_CHECKOUT_RECONCILE" } })).toBe(1);
  });
  it("does not poll closed unpaid subscriptions forever, while retaining recovery for a paid remaining period", async () => {
    const closed = await recoverySubscription(0, "CANCELED", new Date(Date.now() - 86400000));
    const paid = await recoverySubscription(1, "INACTIVE", new Date(Date.now() + 86400000));
    expect(await enqueueBillingRecovery()).toMatchObject({ count: 1 });
    expect(await state.db.billingEvent.findFirstOrThrow()).toMatchObject({ subscriptionId: paid.sub.providerSubscriptionId });
    expect((await state.db.billingSubscription.findUniqueOrThrow({ where: { id: closed.sub.id } })).recoveryEnqueuedAt).toBeNull();
  });
  it("leaves old UNKNOWN creations in the operator queue rather than polling indefinitely", async () => {
    const past = new Date(Date.now() - 8 * 86400000), link = await checkout({ status: "UNKNOWN", createdAt: past, updatedAt: past });
    expect(await enqueueBillingRecovery()).toMatchObject({ count: 0 });
    expect(await state.db.billingEvent.count()).toBe(0); expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("UNKNOWN");
  });
  it("commits each recovery cursor and durable event only once across competing sweeps", async () => {
    const current = await recoverySubscription(0), past = new Date(Date.now() - 8 * 3600000), link = await checkout({ createdAt: past, updatedAt: past });
    const results = await Promise.all(Array.from({ length: 5 }, () => enqueueBillingRecovery()));
    expect(results.reduce((sum, result) => sum + result.count, 0)).toBe(2);
    expect(await state.db.billingEvent.count()).toBe(2);
    expect((await state.db.billingSubscription.findUniqueOrThrow({ where: { id: current.sub.id } })).recoveryEnqueuedAt).not.toBeNull();
    expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).recoveryEnqueuedAt).not.toBeNull();
    expect(await enqueueBillingRecovery()).toMatchObject({ count: 0 });
  });
  it("rolls back recovery cursors when the durable event insert fails", async () => {
    const current = await recoverySubscription(0), past = new Date(Date.now() - 8 * 3600000), link = await checkout({ createdAt: past, updatedAt: past });
    await sql.query(`CREATE FUNCTION recovery_event_test_failure() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only inbox failure'; END $$`);
    await sql.query(`CREATE TRIGGER recovery_event_test_failure BEFORE INSERT ON "BillingEvent" FOR EACH ROW EXECUTE FUNCTION recovery_event_test_failure()`);
    try { await expect(enqueueBillingRecovery()).rejects.toBeDefined(); } finally { await sql.query(`DROP TRIGGER recovery_event_test_failure ON "BillingEvent"`); await sql.query(`DROP FUNCTION recovery_event_test_failure()`); }
    expect(await state.db.billingEvent.count()).toBe(0);
    expect((await state.db.billingSubscription.findUniqueOrThrow({ where: { id: current.sub.id } })).recoveryEnqueuedAt).toBeNull();
    expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: link.id } })).recoveryEnqueuedAt).toBeNull();
    expect(await enqueueBillingRecovery()).toMatchObject({ count: 2 });
  });
});
