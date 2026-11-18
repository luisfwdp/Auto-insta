/** Operational counts on a disposable PostgreSQL schema; no provider HTTP. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type BillingWorkStatus } from "../app/generated/prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const schema = `billing_health_${randomBytes(5).toString("hex")}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { readBillingDeadLetters } from "../lib/billing/health";

const accountA = "10000000-0000-4000-8000-000000000001", accountB = "10000000-0000-4000-8000-000000000002";
const bindings = [
  { workspaceId: "health-a", environment: "sandbox", accountScope: accountA },
  { workspaceId: "health-b", environment: "sandbox", accountScope: accountB },
  { workspaceId: "health-prod", environment: "production", accountScope: accountA },
] as const;
const subscriptions = new Map<string, string>();
let sql: Client;

async function event(binding = bindings[0] as typeof bindings[number], status: BillingWorkStatus = "DEAD") {
  return state.db.billingEvent.create({ data: { environment: binding.environment, accountScope: binding.accountScope, eventId: `health_${randomUUID()}&opaque`, eventType: "PAYMENT_CONFIRMED", paymentId: "pay_fake_private", status,
    attempts: 12, createdAt: new Date("2020-01-01T00:00:00Z"), nextAttemptAt: new Date("2020-01-01T00:00:00Z"), leaseUntil: new Date("2020-01-01T00:00:00Z") } });
}
async function command(binding = bindings[0] as typeof bindings[number], status: BillingWorkStatus = "DEAD") {
  return state.db.billingCommand.create({ data: { workspaceId: binding.workspaceId, subscriptionId: subscriptions.get(binding.workspaceId)!, requestId: randomUUID(), status,
    attempts: 12, createdAt: new Date("2020-01-01T00:00:00Z"), nextAttemptAt: new Date("2020-01-01T00:00:00Z"), leaseUntil: new Date("2020-01-01T00:00:00Z") } });
}

describe.skipIf(!url)("read-only billing dead-letter health", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect(); await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) await sql.query(readFileSync(path.join(root, dir, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4, options: `-c search_path=${schema}` }, { schema }) });
    await state.db.user.create({ data: { id: "health-owner", email: "health-owner@example.test" } });
    const trialStartedAt = new Date("2020-01-01T00:00:00Z"), trialEndsAt = new Date("2020-01-04T00:00:00Z");
    for (const binding of bindings) {
      await state.db.workspace.create({ data: { id: binding.workspaceId, name: binding.workspaceId, ownerId: "health-owner" } });
      await state.db.workspaceBilling.create({ data: { workspaceId: binding.workspaceId, trialStartedAt, trialEndsAt } });
      const checkout = await state.db.billingCheckout.create({ data: { ...binding, requestId: randomUUID(), planId: "pro-v1", amountCents: 14900, firstChargeDate: "2027-01-31", billingAnchorDay: 31, status: "COMPLETED", providerCheckoutId: randomUUID() } });
      const sub = await state.db.billingSubscription.create({ data: { ...binding, checkoutId: checkout.id, providerSubscriptionId: "sub_fake_private", providerCustomerId: "cus_fake_private", planId: "pro-v1", amountCents: 14900, billingAnchorDay: 31, renewalStatus: "ACTIVE" } });
      subscriptions.set(binding.workspaceId, sub.id);
    }
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubEnv("BILLING_ENABLED", "false"); vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", accountA);
    vi.stubEnv("VERCEL_ENV", "test"); vi.stubEnv("FLY_APP_NAME", "local-health-test");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider HTTP forbidden in health tests"));
    await state.db.billingCommand.deleteMany(); await state.db.billingEvent.deleteMany();
  });
  afterAll(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await state.db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });

  it("returns one numeric aggregate during rollback, with no identifiers or provider calls", async () => {
    await event(); await event(); await command();
    const result = await readBillingDeadLetters(); expect(result).toBe(3); expect(typeof result).toBe("number");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("isolates provider environments and account scopes for both inbox and cancellation counts", async () => {
    for (let index = 0; index < bindings.length; index++) {
      for (let count = 0; count <= index; count++) await event(bindings[index]);
      await command(bindings[index]);
    }
    expect(await readBillingDeadLetters()).toBe(2);
    vi.stubEnv("ASAAS_ACCOUNT_SCOPE", accountB); expect(await readBillingDeadLetters()).toBe(3);
    vi.stubEnv("ASAAS_ACCOUNT_SCOPE", accountA); vi.stubEnv("ASAAS_ENVIRONMENT", "production"); expect(await readBillingDeadLetters()).toBe(4);
  });
  it.each(["PENDING", "PROCESSING", "RETRY", "PROCESSED"] as const)("does not count %s work as dead", async status => {
    await event(bindings[0], status); await command(bindings[0], status);
    expect(await readBillingDeadLetters()).toBe(0);
  });
  it("does not age out DEAD rows because their retry time or processing lease expired", async () => {
    await event(); await command();
    await state.db.billingEvent.updateMany({ data: { nextAttemptAt: new Date("2099-01-01T00:00:00Z") } });
    expect(await readBillingDeadLetters()).toBe(2);
  });
  it("clears the aggregate when dead letters are explicitly returned to recovery", async () => {
    await event(); await command(); expect(await readBillingDeadLetters()).toBe(2);
    await state.db.billingEvent.updateMany({ data: { status: "RETRY" } });
    await state.db.billingCommand.updateMany({ data: { status: "RETRY" } });
    expect(await readBillingDeadLetters()).toBe(0);
  });
  it("requires a valid provider scope before executing any financial count query", async () => {
    vi.stubEnv("ASAAS_ACCOUNT_SCOPE", "");
    const events = vi.spyOn(state.db.billingEvent, "count"), commands = vi.spyOn(state.db.billingCommand, "count");
    await expect(readBillingDeadLetters()).rejects.toMatchObject({ code: "BILLING_CONFIGURATION" });
    expect(events).not.toHaveBeenCalled(); expect(commands).not.toHaveBeenCalled();
  });
});
