/** Authenticated inbox durability and lease races on disposable PostgreSQL. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const schema = `billing_inbox_${randomBytes(4).toString("hex")}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { ingestBillingEvent, claimBillingEvents, finishBillingEvent } from "../lib/billing/inbox";
import { POST } from "../app/api/billing/webhook/route";

const scopeA = "8caf98c6-6aef-4673-a7fa-42f918e9c07b", scopeB = "d728998a-be8a-48e5-b85e-83b6c7eb034e";
const checkoutId = "1cd5a90c-cc58-4c29-bda1-59c748d461e7";
const secret = "fake-webhook-token-for-tests-at-least-32-characters";
const event = (id = "evt_opaque&15370") => ({ id, event: "PAYMENT_CONFIRMED", payment: { id: "pay_1_a1B2c3D4", subscription: "sub_local_1", checkoutSession: checkoutId } });
function request(body: string, token: string | null = secret, extra: Record<string, string> = {}) {
  return new NextRequest("https://app.example.test/api/billing/webhook", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "asaas-access-token": token } : {}), ...extra }, body });
}
let sql: Client;

describe.skipIf(!url)("durable Asaas billing inbox", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const migrations = path.join(__dirname, "..", "prisma", "migrations");
    for (const entry of readdirSync(migrations, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort()) await sql.query(readFileSync(path.join(migrations, entry, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10, options: `-c search_path=${schema}` }, { schema }) });
  });
  beforeEach(async () => {
    await state.db.billingEvent.deleteMany();
    vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scopeA);
    vi.stubEnv("ASAAS_WEBHOOK_TOKEN", secret); vi.stubEnv("ASAAS_API_KEY", "fake-distinct-api-key-for-local-test-only");
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("FLY_APP_NAME", "");
    vi.stubEnv("BILLING_ENABLED", "false");
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { vi.unstubAllEnvs(); await state.db?.$disconnect(); if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });

  it("persists only resource IDs before HTTP200, including opaque event IDs with ampersands", async () => {
    const payload = { ...event(), account: { id: scopeB }, customer: { email: "fake-private@example.test", cpfCnpj: "fake-private-document" }, payment: { ...event().payment, creditCard: { creditCardToken: "fake-private-card" }, description: "fake-private-content" } };
    const response = await POST(request(JSON.stringify(payload)));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ received: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const row = await state.db.billingEvent.findFirstOrThrow();
    expect(row).toMatchObject({ eventId: payload.id, eventType: "PAYMENT_CONFIRMED", accountScope: scopeA, paymentId: "pay_1_a1B2c3D4", subscriptionId: "sub_local_1", checkoutId, status: "PENDING", attempts: 0 });
    expect(JSON.stringify(row)).not.toMatch(/fake-private|creditCard|cpfCnpj|email|description/);
  });
  it("keeps ingestion available while the commercial billing flag is disabled", async () => {
    expect(process.env.BILLING_ENABLED).toBe("false");
    expect((await POST(request(JSON.stringify(event())))).status).toBe(200);
    expect(await state.db.billingEvent.count()).toBe(1);
  });
  it("authenticates before reading or parsing the body", async () => {
    const req = request("not JSON and may contain fake private data", "wrong");
    const getReader = vi.spyOn(req.body!, "getReader");
    expect((await POST(req)).status).toBe(401);
    expect(getReader).not.toHaveBeenCalled(); expect(await state.db.billingEvent.count()).toBe(0);
  });
  it("refuses missing request tokens and fails closed for reusing the API key as webhook configuration", async () => {
    expect((await POST(request(JSON.stringify(event()), null))).status).toBe(401);
    vi.stubEnv("ASAAS_WEBHOOK_TOKEN", process.env.ASAAS_API_KEY!);
    expect((await POST(request(JSON.stringify(event()), process.env.ASAAS_API_KEY))).status).toBe(503);
  });
  it("reports unavailable when the webhook secret is not configured without reading a body", async () => {
    vi.stubEnv("ASAAS_WEBHOOK_TOKEN", "");
    const req = request(JSON.stringify(event())), getReader = vi.spyOn(req.body!, "getReader");
    expect((await POST(req)).status).toBe(503); expect(getReader).not.toHaveBeenCalled();
  });
  it("fails closed for missing provider scope without reading the body", async () => {
    vi.stubEnv("ASAAS_ACCOUNT_SCOPE", "");
    const req = request(JSON.stringify(event())), getReader = vi.spyOn(req.body!, "getReader");
    expect((await POST(req)).status).toBe(503); expect(getReader).not.toHaveBeenCalled();
    expect(await state.db.billingEvent.count()).toBe(0);
  });
  it.each(["declared", "actual", "utf8"])("bounds %s request bytes before storing anything", async kind => {
    const req = kind === "declared" ? request("{}", secret, { "Content-Length": "65537" }) : request((kind === "utf8" ? "ç" : "x").repeat(kind === "utf8" ? 33000 : 65537));
    expect((await POST(req)).status).toBe(413); expect(await state.db.billingEvent.count()).toBe(0);
  });
  it.each([
    "not JSON", JSON.stringify({ ...event(), id: "evt_bad\ncontrol" }), JSON.stringify({ ...event(), id: "x".repeat(201) }),
    JSON.stringify({ ...event(), event: "payment_confirmed" }), JSON.stringify({ ...event(), payment: null }),
    JSON.stringify({ ...event(), payment: { id: "pay_../secret" } }), JSON.stringify({ id: "evt_sub", event: "SUBSCRIPTION_CREATED" }),
    JSON.stringify({ id: "evt_checkout", event: "CHECKOUT_PAID", checkout: { id: "not-uuid" } }),
  ])("rejects malformed envelopes without exposing body data %#", async body => {
    const response = await POST(request(body)); expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: "INVALID_BILLING_EVENT" });
    expect(await state.db.billingEvent.count()).toBe(0);
  });
  it("does not acknowledge a failed durable insert or expose database details", async () => {
    vi.spyOn(state.db.billingEvent, "createMany").mockRejectedValueOnce(new Error("fake-private-database-secret"));
    const response = await POST(request(JSON.stringify(event())));
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("fake-private");
    expect(await state.db.billingEvent.count()).toBe(0);
  });
  it("coalesces concurrent deliveries into one persistent inbox record", async () => {
    const values = await Promise.all(Array.from({ length: 30 }, () => ingestBillingEvent(event())));
    expect(new Set(values.map(x => x.id)).size).toBe(1); expect(values.filter(x => !x.duplicate)).toHaveLength(1);
    expect(await state.db.billingEvent.count()).toBe(1);
  });
  it("survives a lost acknowledgement without resetting a live worker lease", async () => {
    const first = await ingestBillingEvent(event());
    const now = new Date(Date.now() + 1000), [claimed] = await claimBillingEvents(1, now);
    expect((await POST(request(JSON.stringify(event())))).status).toBe(200);
    expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "PROCESSING", attempts: 1, leaseToken: claimed.leaseToken, leaseUntil: claimed.leaseUntil });
  });
  it("does not mutate the first event when a duplicate ID changes its binding", async () => {
    const first = await ingestBillingEvent(event());
    const response = await POST(request(JSON.stringify({ ...event(), payment: { ...event().payment, id: "pay_other" } })));
    expect(response.status).toBe(409);
    expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ paymentId: event().payment.id, status: "PENDING", attempts: 0 });
  });
  it("scopes duplicate IDs and worker claims by configured account and environment", async () => {
    const a = await ingestBillingEvent(event());
    vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scopeB); const b = await ingestBillingEvent(event());
    vi.stubEnv("ASAAS_ENVIRONMENT", "production"); const production = await ingestBillingEvent(event());
    expect(new Set([a.id, b.id, production.id]).size).toBe(3);
    const claimed = await claimBillingEvents(20, new Date(Date.now() + 1000));
    expect(claimed.map(x => x.id)).toEqual([production.id]);
    vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scopeA);
    expect(await finishBillingEvent(production.id, claimed[0].leaseToken!, "processed")).toBe(false);
    expect((await claimBillingEvents(20, new Date(Date.now() + 1000))).map(x => x.id)).toEqual([a.id]);
  });
  it("stores future unknown events as minimal envelopes without treating them as paid", async () => {
    await ingestBillingEvent({ id: "evt_future", event: "UNKNOWN_FUTURE_EVENT", payload: { token: "fake-private" } });
    const row = await state.db.billingEvent.findFirstOrThrow();
    expect(row).toMatchObject({ eventType: "UNKNOWN_FUTURE_EVENT", paymentId: null, subscriptionId: null, checkoutId: null });
    expect(JSON.stringify(row)).not.toContain("fake-private");
  });
  it("preserves checkout and subscription IDs from their documented resource objects", async () => {
    await ingestBillingEvent({ id: "evt_checkout", event: "CHECKOUT_CREATED", checkout: { id: checkoutId, items: [{ name: "fake-private" }] } });
    await ingestBillingEvent({ id: "evt_sub", event: "SUBSCRIPTION_DELETED", subscription: { id: "sub_example", customer: "cus_private" } });
    expect(await state.db.billingEvent.findFirstOrThrow({ where: { eventId: "evt_checkout" } })).toMatchObject({ checkoutId, paymentId: null, subscriptionId: null });
    expect(await state.db.billingEvent.findFirstOrThrow({ where: { eventId: "evt_sub" } })).toMatchObject({ subscriptionId: "sub_example", checkoutId: null, paymentId: null });
  });
  it("never gives two workers the same live event claim", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => ingestBillingEvent(event(`evt_${i}`))));
    const now = new Date(Date.now() + 1000);
    const batches = await Promise.all(Array.from({ length: 4 }, () => claimBillingEvents(10, now)));
    const rows = batches.flat(); expect(rows).toHaveLength(20); expect(new Set(rows.map(x => x.id)).size).toBe(20);
    expect(await claimBillingEvents(20, now)).toEqual([]);
  });
  it("recovers a crashed lease at expiry and rejects every stale-owner completion", async () => {
    await ingestBillingEvent(event()); const firstTime = new Date(Date.now() + 1000);
    const [old] = await claimBillingEvents(1, firstTime);
    const expired = new Date(firstTime.getTime() + 180000), [replacement] = await claimBillingEvents(1, expired);
    expect(replacement.id).toBe(old.id); expect(replacement.attempts).toBe(2); expect(replacement.leaseToken).not.toBe(old.leaseToken);
    for (const outcome of ["processed", "retry", "dead"] as const) expect(await finishBillingEvent(old.id, old.leaseToken!, outcome, "STALE", expired)).toBe(false);
    expect(await finishBillingEvent(replacement.id, replacement.leaseToken!, "processed", undefined, expired)).toBe(true);
    expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: "PROCESSED", attempts: 2, leaseToken: null, leaseUntil: null });
  });
  it("does not allow completion at the exact lease boundary", async () => {
    await ingestBillingEvent(event()); const now = new Date(Date.now() + 1000), [claimed] = await claimBillingEvents(1, now);
    expect(await finishBillingEvent(claimed.id, claimed.leaseToken!, "processed", undefined, claimed.leaseUntil!)).toBe(false);
  });
  it("backs off retryable work, redacts free-form errors and preserves retry state on redelivery", async () => {
    await ingestBillingEvent(event()); const now = new Date(Date.now() + 1000), [claimed] = await claimBillingEvents(1, now);
    expect(await finishBillingEvent(claimed.id, claimed.leaseToken!, "retry", "$aact_fake_secret", now)).toBe(true);
    const row = await state.db.billingEvent.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(row).toMatchObject({ status: "RETRY", attempts: 1, lastErrorCode: "BILLING_PROCESSING_FAILED" });
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + 1000);
    await ingestBillingEvent(event()); expect((await state.db.billingEvent.findUniqueOrThrow({ where: { id: claimed.id } })).nextAttemptAt).toEqual(row.nextAttemptAt);
    expect(await claimBillingEvents(1, now)).toEqual([]);
    expect((await claimBillingEvents(1, row.nextAttemptAt))[0].attempts).toBe(2);
  });
  it("ends retry loops at the durable attempt budget and never resurrects dead work on duplicate delivery", async () => {
    const item = await ingestBillingEvent(event());
    await state.db.billingEvent.update({ where: { id: item.id }, data: { attempts: 11 } });
    const now = new Date(Date.now() + 1000), [claimed] = await claimBillingEvents(1, now);
    expect(claimed.attempts).toBe(12);
    expect(await finishBillingEvent(claimed.id, claimed.leaseToken!, "retry", "PROVIDER_UNAVAILABLE", now)).toBe(true);
    await ingestBillingEvent(event());
    expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "DEAD", attempts: 12 });
    expect(await claimBillingEvents(20, new Date(now.getTime() + 86400000))).toEqual([]);
  });
  it("dead-letters exhausted crash recovery without increment overflow", async () => {
    const item = await ingestBillingEvent(event());
    await state.db.billingEvent.update({ where: { id: item.id }, data: { attempts: 12, status: "PROCESSING", leaseToken: randomUUID(), leaseUntil: new Date(0) } });
    expect(await claimBillingEvents()).toEqual([]);
    expect(await state.db.billingEvent.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "DEAD", attempts: 12, lastErrorCode: "ATTEMPTS_EXHAUSTED" });
  });
});
