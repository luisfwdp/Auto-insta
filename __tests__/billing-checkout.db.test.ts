/** Real services + PostgreSQL in an isolated schema, with a fully typed fake
 * Asaas adapter. No HTTP is permitted; TEST_DATABASE_URL is disposable only.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const schema = `billing_checkout_${randomBytes(5).toString("hex")}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { requestCheckout, readCheckout, recoverInterruptedCheckouts, type CheckoutRequest } from "../lib/billing/checkout";
import { requestSubscriptionCancellation, readCancellation, processBillingCancellations } from "../lib/billing/cancellation";
import { claimBillingSync, assertBillingSyncLease, releaseBillingSync } from "../lib/billing/sync-lease";
import { startCardFreeTrial, billingStatusDTO } from "../lib/billing/trial";
import { decryptToken, encryptToken } from "../lib/meta/oauth";
import { AsaasError, type createAsaasClient, type AsaasSubscriptionDTO } from "../lib/billing/asaas-client";

type Gateway = ReturnType<typeof createAsaasClient>;
const scope = "10000000-0000-4000-8000-000000000001";
const providerCheckoutId = "20000000-0000-4000-8000-000000000002";
const hostedUrl = `https://sandbox.asaas.com/123/checkoutSession/show/${providerCheckoutId}?tag=fake`;
const request = (patch: Partial<CheckoutRequest> = {}): CheckoutRequest => ({ requestId: randomUUID(), planId: "pro-v1", expectedAmountCents: 14900, acceptImmediateCharge: true, ...patch });
const canonicalSubscription = (patch: Partial<AsaasSubscriptionDTO> = {}): AsaasSubscriptionDTO => ({ id: "sub_authorized", customer: "cus_authorized", status: "ACTIVE", valueCents: 14900,
  cycle: "MONTHLY", deleted: false, checkoutSession: providerCheckoutId, ...patch });
function gateway() {
  return {
    createHostedCheckout: vi.fn<Gateway["createHostedCheckout"]>().mockResolvedValue({ id: providerCheckoutId, url: hostedUrl }),
    getPayment: vi.fn<Gateway["getPayment"]>().mockRejectedValue(new Error("Unexpected payment lookup")),
    getSubscription: vi.fn<Gateway["getSubscription"]>().mockResolvedValue(canonicalSubscription()),
    listPaymentsByCheckout: vi.fn<Gateway["listPaymentsByCheckout"]>().mockResolvedValue({ data: [], hasMore: false, totalCount: 0, offset: 0, limit: 20 }),
    listPaymentsBySubscription: vi.fn<Gateway["listPaymentsBySubscription"]>().mockResolvedValue({ data: [], hasMore: false, totalCount: 0, offset: 0, limit: 20 }),
    cancelSubscription: vi.fn<Gateway["cancelSubscription"]>().mockResolvedValue({ id: "sub_authorized", deleted: true }),
  } satisfies Gateway;
}
async function seedSubscription(paidThrough: Date | null = new Date(Date.now() + 86400000), renewalStatus = "ACTIVE") {
  const checkout = await state.db.billingCheckout.create({ data: { workspaceId: "workspace-a", environment: "sandbox", accountScope: scope, requestId: randomUUID(), planId: "pro-v1",
    amountCents: 14900, firstChargeDate: "2027-01-31", billingAnchorDay: 31, status: "COMPLETED", providerCheckoutId } });
  const sub = await state.db.billingSubscription.create({ data: { workspaceId: "workspace-a", environment: "sandbox", accountScope: scope, providerSubscriptionId: "sub_authorized",
    providerCustomerId: "cus_authorized", checkoutId: checkout.id, planId: "pro-v1", amountCents: 14900, billingAnchorDay: 31, renewalStatus } });
  await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { currentSubscriptionId: sub.id, status: "ACTIVE", paidThrough } });
  return { sub, checkout, paidThrough };
}
async function seedOldOpenCheckout() {
  return state.db.billingCheckout.create({ data: { workspaceId: "workspace-a", environment: "sandbox", accountScope: scope,
    requestId: randomUUID(), planId: "pro-v1", amountCents: 14900, firstChargeDate: "2027-01-31", billingAnchorDay: 31,
    status: "OPEN", providerCheckoutId, checkoutUrlCiphertext: encryptToken(hostedUrl), createdAt: new Date(Date.now() - 66 * 60_000) } });
}
let sql: Client;

describe.skipIf(!url)("durable checkout and cancellation services", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect(); await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort()) await sql.query(readFileSync(path.join(root, dir, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10, options: `-c search_path=${schema}` }, { schema }) });
    await state.db.user.create({ data: { id: "checkout-owner", email: "checkout-owner@example.test" } });
    for (const id of ["workspace-a", "workspace-b"]) await state.db.workspace.create({ data: { id, name: id, ownerId: "checkout-owner" } });
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scope);
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.test"); vi.stubEnv("ENCRYPTION_KEY", "11".repeat(32)); vi.stubEnv("ASAAS_API_KEY", "fake-api-credential-for-local-tests-only");
    vi.stubEnv("VERCEL_ENV", "test"); vi.stubEnv("FLY_APP_NAME", "local-financial-test");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Real HTTP forbidden in financial service tests"));
    await state.db.workspaceBilling.updateMany({ data: { currentSubscriptionId: null } });
    await state.db.billingPayment.deleteMany(); await state.db.billingEvent.deleteMany(); await state.db.billingCommand.deleteMany();
    await state.db.billingSubscription.deleteMany(); await state.db.billingCheckout.deleteMany();
    await state.db.workspaceBilling.deleteMany(); await state.db.trialRedemption.deleteMany();
    await startCardFreeTrial("workspace-a"); await startCardFreeTrial("workspace-b");
  });
  afterAll(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await state.db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });

  it("commits the immutable intent before provider POST and holds no database lock across network I/O", async () => {
    const provider = gateway(), input = request();
    provider.createHostedCheckout.mockImplementation(async payload => {
      const row = await state.db.billingCheckout.findUniqueOrThrow({ where: { id: payload.reference } });
      expect(row).toMatchObject({ workspaceId: "workspace-a", requestId: input.requestId, planId: "pro-v1", amountCents: 14900, status: "CREATING", providerCheckoutId: null });
      expect(payload).toMatchObject({ amountCents: 14900, firstChargeDate: row.firstChargeDate });
      await state.db.$transaction(tx => tx.$queryRaw`SELECT "workspaceId" FROM "WorkspaceBilling" WHERE "workspaceId"='workspace-a' FOR UPDATE NOWAIT`);
      return { id: providerCheckoutId, url: hostedUrl };
    });
    const dto = await requestCheckout("workspace-a", input, provider);
    expect(dto).toMatchObject({ status: "OPEN", planId: "pro-v1", amountCents: 14900, url: hostedUrl });
    expect(provider.createHostedCheckout).toHaveBeenCalledOnce(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(["same request", "different requests"])("concurrent20 %s produce one durable checkout and exactly one POST", async mode => {
    const provider = gateway(), input = request();
    const results = await Promise.all(Array.from({ length: 20 }, () => requestCheckout("workspace-a", mode === "same request" ? input : request(), provider)));
    expect(new Set(results.map(row => row.id)).size).toBe(1); expect(await state.db.billingCheckout.count()).toBe(1);
    expect(provider.createHostedCheckout).toHaveBeenCalledOnce();
  });
  it("does not reset a redeemed trial when requesting or retrying checkout", async () => {
    const before = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
    const redemption = await state.db.trialRedemption.findUniqueOrThrow({ where: { ownerId: "checkout-owner" } });
    const provider = gateway(), input = request(); await requestCheckout("workspace-a", input, provider); await requestCheckout("workspace-a", input, provider);
    expect(await state.db.trialRedemption.findUniqueOrThrow({ where: { ownerId: "checkout-owner" } })).toEqual(redemption);
    const after = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
    expect(after.trialStartedAt).toEqual(before.trialStartedAt); expect(after.trialEndsAt).toEqual(before.trialEndsAt); expect(provider.createHostedCheckout).toHaveBeenCalledOnce();
  });
  it.each([
    { expectedAmountCents: 7900 }, { acceptImmediateCharge: false }, { acceptImmediateCharge: undefined }, { creditCard: { number: "fake-private" } },
    { workspaceId: "workspace-b" }, { requestId: "../fake" },
  ])("rejects browser price/consent/extra-field violations before a provider mutation %#", async patch => {
    const provider = gateway();
    // Deliberately model untrusted JSON at the service boundary; runtime schema
    // validation remains enabled and the actual provider is a fully typed mock.
    const value = { ...request(), ...patch } as unknown as CheckoutRequest;
    await expect(requestCheckout("workspace-a", value, provider)).rejects.toMatchObject({ code: Object.hasOwn(patch, "expectedAmountCents") ? "OFFER_CHANGED" : "INVALID_REQUEST" });
    expect(provider.createHostedCheckout).not.toHaveBeenCalled(); expect(await state.db.billingCheckout.count()).toBe(0);
  });
  it("scopes checkout reads to workspace and provider environment while exposing an allowlisted decrypted DTO", async () => {
    const provider = gateway(), dto = await requestCheckout("workspace-a", request(), provider);
    const row = await state.db.billingCheckout.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.checkoutUrlCiphertext).not.toContain(hostedUrl); expect(decryptToken(row.checkoutUrlCiphertext!)).toBe(hostedUrl);
    expect(row.checkoutUrlCiphertext).not.toBe(hostedUrl); expect(Object.keys(dto).sort()).toEqual(["amountCents", "id", "planId", "status", "url"]);
    await expect(readCheckout("workspace-b", dto.id)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    vi.stubEnv("ASAAS_ENVIRONMENT", "production"); await expect(readCheckout("workspace-a", dto.id)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); expect(await readCheckout("workspace-a", dto.id)).toEqual(dto);
  });
  it("validates encryption readiness before creating an intent or calling the provider", async () => {
    vi.stubEnv("ENCRYPTION_KEY", ""); const provider = gateway();
    await expect(requestCheckout("workspace-a", request(), provider)).rejects.toThrow();
    expect(provider.createHostedCheckout).not.toHaveBeenCalled(); expect(await state.db.billingCheckout.count()).toBe(0);
  });
  it("rejects a missing callback origin before persisting any intent or POSTing, even with an injected provider", async () => {
    vi.stubEnv("NEXTAUTH_URL", undefined); vi.stubEnv("AUTH_URL", undefined);
    const provider = gateway();
    await expect(requestCheckout("workspace-a", request(), provider)).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(await state.db.billingCheckout.count()).toBe(0); expect(provider.createHostedCheckout).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("recovers a known old OPEN checkout on explicit request before allowing one separate newly authorized checkout", async () => {
    const old = await seedOldOpenCheckout(), provider = gateway(), nextProviderId = randomUUID();
    provider.createHostedCheckout.mockResolvedValue({ id: nextProviderId, url: `https://sandbox.asaas.com/checkoutSession/show?id=${nextProviderId}` });
    provider.listPaymentsByCheckout.mockImplementation(async (checkoutId, options) => {
      expect(checkoutId).toBe(providerCheckoutId); expect(options).toEqual({ offset: 0, limit: 20 });
      // Canonical reads must happen outside the original checkout transaction.
      await state.db.$transaction(tx => tx.$queryRaw`SELECT "workspaceId" FROM "WorkspaceBilling" WHERE "workspaceId"='workspace-a' FOR UPDATE NOWAIT`);
      return { data: [], hasMore: false, totalCount: 0, offset: 0, limit: 20 };
    });
    expect(await requestCheckout("workspace-a", request({ requestId: old.requestId }), provider)).toEqual({ id: old.id, status: "EXPIRED", planId: "pro-v1", amountCents: 14900, url: null });
    expect(provider.listPaymentsByCheckout).toHaveBeenCalledTimes(2); expect(provider.createHostedCheckout).not.toHaveBeenCalled();
    expect(await state.db.billingCheckout.count()).toBe(1);
    expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("EXPIRED");
    const results = await Promise.all(Array.from({ length: 20 }, () => requestCheckout("workspace-a", request(), provider)));
    expect(new Set(results.map(value => value.id)).size).toBe(1); expect(results[0].id).not.toBe(old.id);
    expect(provider.createHostedCheckout).toHaveBeenCalledOnce(); expect(provider.listPaymentsByCheckout).toHaveBeenCalledTimes(2);
    expect(await state.db.billingCheckout.count()).toBe(2);
    expect(await state.db.billingCheckout.findFirstOrThrow({ where: { workspaceId: "workspace-a", id: results[0].id } })).toMatchObject({ status: "OPEN", providerCheckoutId: nextProviderId });
    expect(await readCheckout("workspace-a", old.id)).toMatchObject({ status: "EXPIRED", url: null });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("does not expire or re-POST an old OPEN checkout with persisted CHECKOUT_PAID evidence and an empty canonical index", async () => {
    const old = await seedOldOpenCheckout(), provider = gateway();
    await state.db.billingEvent.create({ data: { environment: "sandbox", accountScope: scope, eventId: "evt_paid_evidence&opaque", eventType: "CHECKOUT_PAID", checkoutId: providerCheckoutId } });
    for (const input of [request({ requestId: old.requestId }), request()]) {
      await expect(requestCheckout("workspace-a", input, provider)).rejects.toMatchObject({ code: "PAYMENT_NOT_VISIBLE", httpStatus: 503 });
    }
    expect(provider.listPaymentsByCheckout).toHaveBeenCalledTimes(4);
    expect(await state.db.billingCheckout.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: "OPEN", providerCheckoutId });
    expect(await state.db.billingCheckout.count()).toBe(1); expect(provider.createHostedCheckout).not.toHaveBeenCalled();
    expect((await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).syncLeaseToken).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("keeps unknown POST outcomes durable and never POSTs again for the same or a new request id", async () => {
    const provider = gateway(), input = request(); provider.createHostedCheckout.mockRejectedValueOnce(new AsaasError("UNKNOWN_OUTCOME"));
    await expect(requestCheckout("workspace-a", input, provider)).rejects.toMatchObject({ code: "CHECKOUT_OUTCOME_UNKNOWN", httpStatus: 503 });
    const row = await state.db.billingCheckout.findFirstOrThrow(); expect(row).toMatchObject({ status: "UNKNOWN", providerCheckoutId: null, checkoutUrlCiphertext: null });
    expect(await requestCheckout("workspace-a", input, provider)).toMatchObject({ id: row.id, status: "UNKNOWN", url: null });
    expect(await requestCheckout("workspace-a", request(), provider)).toMatchObject({ id: row.id, status: "UNKNOWN", url: null });
    expect(provider.createHostedCheckout).toHaveBeenCalledOnce();
  });
  it("recovers only interrupted CREATING intents into UNKNOWN without repeating their POST", async () => {
    const old = await state.db.billingCheckout.create({ data: { workspaceId: "workspace-a", environment: "sandbox", accountScope: scope, requestId: randomUUID(), planId: "pro-v1", amountCents: 14900,
      firstChargeDate: "2027-01-31", billingAnchorDay: 31, createdAt: new Date(Date.now() - 180_000) } });
    const recent = await state.db.billingCheckout.create({ data: { workspaceId: "workspace-b", environment: "sandbox", accountScope: scope, requestId: randomUUID(), planId: "pro-v1", amountCents: 14900, firstChargeDate: "2027-01-31", billingAnchorDay: 31 } });
    const foreign = await state.db.billingCheckout.create({ data: { workspaceId: "workspace-a", environment: "production", accountScope: scope, requestId: randomUUID(), planId: "pro-v1", amountCents: 14900, firstChargeDate: "2027-01-31", billingAnchorDay: 31, createdAt: new Date(Date.now() - 180_000) } });
    expect(await recoverInterruptedCheckouts()).toMatchObject({ count: 1 });
    expect(await state.db.billingCheckout.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: "UNKNOWN", lastErrorCode: "CREATE_INTERRUPTED" });
    for (const row of [recent, foreign]) expect((await state.db.billingCheckout.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("CREATING");
    const provider = gateway(); expect(await requestCheckout("workspace-a", request(), provider)).toMatchObject({ id: old.id, status: "UNKNOWN", url: null });
    expect(provider.createHostedCheckout).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("preserves known provider identity after the first result-persistence write fails and returns no unproven URL", async () => {
    const provider = gateway(), input = request();
    const write = vi.spyOn(state.db.billingCheckout, "updateMany").mockRejectedValueOnce(new Error("Simulated first write outage"));
    await expect(requestCheckout("workspace-a", input, provider)).rejects.toMatchObject({ code: "CHECKOUT_OUTCOME_UNKNOWN" });
    expect(write).toHaveBeenCalledTimes(2);
    const row = await state.db.billingCheckout.findFirstOrThrow(); expect(row).toMatchObject({ status: "UNKNOWN", providerCheckoutId, checkoutUrlCiphertext: null });
    expect(await readCheckout("workspace-a", row.id)).toMatchObject({ status: "UNKNOWN", url: null });
    expect(await requestCheckout("workspace-a", request(), provider)).toMatchObject({ id: row.id, status: "UNKNOWN", url: null });
    expect(provider.createHostedCheckout).toHaveBeenCalledOnce();
  });
  it.each(["paid period", "active subscription"])("blocks a second subscription for an existing %s", async mode => {
    await seedSubscription(mode === "paid period" ? new Date(Date.now() + 86400000) : null);
    const provider = gateway();
    await expect(requestCheckout("workspace-a", request(), provider)).rejects.toMatchObject({ code: mode === "paid period" ? "ALREADY_PAID" : "SUBSCRIPTION_EXISTS" });
    expect(provider.createHostedCheckout).not.toHaveBeenCalled(); expect(await state.db.billingCheckout.count()).toBe(1);
  });
  it("blocks checkout during a financial sync lease", async () => {
    const token = await claimBillingSync("workspace-a"), provider = gateway();
    await expect(requestCheckout("workspace-a", request(), provider)).rejects.toMatchObject({ code: "FINANCIAL_SYNC_BUSY" });
    expect(provider.createHostedCheckout).not.toHaveBeenCalled(); await releaseBillingSync("workspace-a", token);
  });

  it("cancellation requests persist one outbox command under concurrency without calling DELETE, even with sales disabled", async () => {
    const { sub } = await seedSubscription(); vi.stubEnv("BILLING_ENABLED", "false");
    const responses = await Promise.all(Array.from({ length: 20 }, () => requestSubscriptionCancellation("workspace-a", randomUUID())));
    expect(new Set(responses.map(row => row.id)).size).toBe(1); expect(await state.db.billingCommand.count()).toBe(1);
    expect(await state.db.billingCommand.findFirstOrThrow()).toMatchObject({ workspaceId: "workspace-a", subscriptionId: sub.id, status: "PENDING", attempts: 0 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await expect(readCancellation("workspace-b", responses[0].id)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    expect(await readCancellation("workspace-a", responses[0].id)).toEqual(responses[0]);
  });
  it("processes only durable commands and GETs canonical state before DELETE while preserving paidThrough", async () => {
    const { paidThrough } = await seedSubscription(), provider = gateway(), calls: string[] = [];
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 0 }); expect(provider.getSubscription).not.toHaveBeenCalled(); expect(provider.cancelSubscription).not.toHaveBeenCalled();
    const command = await requestSubscriptionCancellation("workspace-a", randomUUID());
    provider.getSubscription.mockImplementation(async id => {
      calls.push("GET"); expect(id).toBe("sub_authorized");
      expect(await state.db.billingCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ status: "PROCESSING", attempts: 1 });
      expect((await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).syncLeaseToken).not.toBeNull();
      return canonicalSubscription();
    });
    provider.cancelSubscription.mockImplementation(async id => { calls.push("DELETE"); expect(calls).toEqual(["GET", "DELETE"]); return { id, deleted: true }; });
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 1 });
    expect(await state.db.billingCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ status: "PROCESSED", leaseToken: null, leaseUntil: null });
    expect(await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).toMatchObject({ status: "CANCELED", paidThrough, syncLeaseToken: null });
    expect(billingStatusDTO(await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).hasAccess).toBe(true);
  });
  it("keeps the original72-hour trial after canceling a bound subscription whose payment is still pending", async () => {
    const { sub } = await seedSubscription(null), provider = gateway();
    await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { status: "TRIALING" } });
    await state.db.billingPayment.create({ data: { workspaceId: "workspace-a", subscriptionId: sub.id, environment: "sandbox", accountScope: scope,
      providerPaymentId: "pay_pending", amountCents: 14900, dueDate: "2027-01-31", status: "PENDING", deleted: false } });
    const before = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
    expect(before.trialEndsAt.getTime() - before.trialStartedAt.getTime()).toBe(72 * 3600_000);
    const command = await requestSubscriptionCancellation("workspace-a", randomUUID());
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 1 });
    const after = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
    expect(after).toMatchObject({ status: "TRIALING", paidThrough: null, trialStartedAt: before.trialStartedAt, trialEndsAt: before.trialEndsAt });
    expect(billingStatusDTO(after)).toMatchObject({ status: "TRIALING", hasAccess: true, trialEndsAt: before.trialEndsAt.toISOString() });
    expect((await state.db.billingCommand.findUniqueOrThrow({ where: { id: command.id } })).status).toBe("PROCESSED");
    expect(provider.cancelSubscription).toHaveBeenCalledOnce();
  });
  it.each(["before start", "at expiry", "after expiry"] as const)("does not grant a trial %s after cancellation, or reset its original dates", async boundary => {
    await seedSubscription(null); const provider = gateway();
    await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { status: "TRIALING" } });
    const before = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
    const command = await requestSubscriptionCancellation("workspace-a", randomUUID());
    await state.db.billingCommand.update({ where: { id: command.id }, data: { nextAttemptAt: new Date(0) } });
    const instant = boundary === "before start" ? before.trialStartedAt.getTime() - 1 : before.trialEndsAt.getTime() + (boundary === "after expiry" ? 1 : 0);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(instant);
    try {
      expect(await processBillingCancellations(5, provider)).toEqual({ processed: 1 });
      const after = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
      expect(after).toMatchObject({ status: "CANCELED", paidThrough: null, trialStartedAt: before.trialStartedAt, trialEndsAt: before.trialEndsAt });
      expect(billingStatusDTO(after)).toMatchObject({ status: "CANCELED", hasAccess: false });
    } finally { vi.useRealTimers(); }
  });
  it("does not lift a suspension while canceling renewal and preserves paid and trial dates", async () => {
    const { paidThrough } = await seedSubscription(), provider = gateway();
    await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { status: "SUSPENDED" } });
    const before = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
    await requestSubscriptionCancellation("workspace-a", randomUUID());
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 1 });
    const after = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
    expect(after).toMatchObject({ status: "SUSPENDED", paidThrough, trialStartedAt: before.trialStartedAt, trialEndsAt: before.trialEndsAt });
    expect(billingStatusDTO(after).hasAccess).toBe(false);
    expect(provider.cancelSubscription).toHaveBeenCalledOnce();
  });
  it("can cancel after provider price/cycle changes when customer and checkout linkage remain correct", async () => {
    await seedSubscription(); const provider = gateway();
    provider.getSubscription.mockResolvedValue(canonicalSubscription({ valueCents: 7900, cycle: "YEARLY" }));
    await requestSubscriptionCancellation("workspace-a", randomUUID());
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 1 }); expect(provider.cancelSubscription).toHaveBeenCalledOnce();
  });
  it.each(["customer", "checkout"])("refuses DELETE for a canonical %s mismatch", async mismatch => {
    await seedSubscription(); const provider = gateway();
    provider.getSubscription.mockResolvedValue(canonicalSubscription(mismatch === "customer" ? { customer: "cus_foreign" } : { checkoutSession: randomUUID() }));
    const command = await requestSubscriptionCancellation("workspace-a", randomUUID());
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 0 }); expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(await state.db.billingCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "CANONICAL_LINK_MISMATCH" });
    expect((await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).status).toBe("ACTIVE");
  });
  it("reconciles an ambiguous DELETE by GET on retry and never repeats DELETE after canonical deleted:true", async () => {
    const { paidThrough } = await seedSubscription(), provider = gateway();
    provider.getSubscription.mockResolvedValueOnce(canonicalSubscription()).mockResolvedValueOnce(canonicalSubscription({ deleted: true, status: "INACTIVE" }));
    provider.cancelSubscription.mockRejectedValueOnce(new AsaasError("UNKNOWN_OUTCOME"));
    const command = await requestSubscriptionCancellation("workspace-a", randomUUID());
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 0 });
    expect(await state.db.billingCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "UNKNOWN_OUTCOME" });
    await state.db.billingCommand.update({ where: { id: command.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 1 }); expect(provider.getSubscription).toHaveBeenCalledTimes(2); expect(provider.cancelSubscription).toHaveBeenCalledOnce();
    expect(await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).toMatchObject({ status: "CANCELED", paidThrough });
  });
  it("still DELETEs INACTIVE subscriptions to remove their pending invoices", async () => {
    await seedSubscription(null, "INACTIVE"); const provider = gateway(); provider.getSubscription.mockResolvedValue(canonicalSubscription({ status: "INACTIVE" }));
    await requestSubscriptionCancellation("workspace-a", randomUUID());
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 1 }); expect(provider.cancelSubscription).toHaveBeenCalledOnce();
  });
  it("does not let a displaced financial lease owner complete or release the new owner's lease", async () => {
    const { paidThrough } = await seedSubscription(), provider = gateway(), newToken = randomUUID();
    const command = await requestSubscriptionCancellation("workspace-a", randomUUID());
    provider.cancelSubscription.mockImplementation(async id => {
      await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { syncLeaseToken: newToken, syncLeaseUntil: new Date(Date.now() + 180000) } });
      return { id, deleted: true };
    });
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 0 });
    expect(await state.db.billingCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "SYNC_LEASE_LOST" });
    expect(await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).toMatchObject({ status: "ACTIVE", paidThrough, syncLeaseToken: newToken });
  });
  it("cannot complete an expired command lease, then recovers it with GET without repeating DELETE", async () => {
    const { paidThrough } = await seedSubscription(), provider = gateway();
    const command = await requestSubscriptionCancellation("workspace-a", randomUUID());
    provider.cancelSubscription.mockImplementationOnce(async id => {
      await state.db.billingCommand.update({ where: { id: command.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
      return { id, deleted: true };
    });
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 0 });
    expect((await state.db.billingCommand.findUniqueOrThrow({ where: { id: command.id } })).status).toBe("PROCESSING");
    expect(await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).toMatchObject({ status: "ACTIVE", paidThrough });
    provider.getSubscription.mockResolvedValue(canonicalSubscription({ deleted: true, status: "INACTIVE" }));
    expect(await processBillingCancellations(5, provider)).toEqual({ processed: 1 }); expect(provider.cancelSubscription).toHaveBeenCalledOnce();
  });
  it("requires a current sync token and expiry for transactional writes, with safe stale-token release", async () => {
    const stale = await claimBillingSync("workspace-a");
    await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { syncLeaseUntil: new Date(Date.now() - 1000) } });
    await expect(state.db.$transaction(tx => assertBillingSyncLease(tx, "workspace-a", stale))).rejects.toMatchObject({ code: "SYNC_LEASE_LOST" });
    const current = await claimBillingSync("workspace-a"); await releaseBillingSync("workspace-a", stale);
    await expect(state.db.$transaction(tx => assertBillingSyncLease(tx, "workspace-a", stale))).rejects.toMatchObject({ code: "SYNC_LEASE_LOST" });
    expect((await state.db.$transaction(tx => assertBillingSyncLease(tx, "workspace-a", current))).syncLeaseToken).toBe(current);
    await releaseBillingSync("workspace-a", current);
    expect((await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).syncLeaseToken).toBeNull();
  });
});
