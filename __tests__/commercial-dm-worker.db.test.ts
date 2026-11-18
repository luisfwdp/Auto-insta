/** Full DM processor and commercial ledger on an isolated PostgreSQL schema.
 * Only BullMQ/Redis infrastructure and Meta transport use fixtures; no real API. */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import type { Job } from "bullmq";
import type { DmQueueJob } from "../lib/queue/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const url = process.env.TEST_DATABASE_URL, schema = `commercial_worker_${randomBytes(5).toString("hex")}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  processor: undefined as unknown as (job: import("bullmq").Job<import("../lib/queue/client").DmQueueJob>) => Promise<void>,
  plain: vi.fn(), template: vi.fn(), button: vi.fn(), follows: vi.fn(), queueAdd: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/meta/client", async original => ({ ...await original<typeof import("../lib/meta/client")>(),
  sendDirectMessage: (...args: unknown[]) => state.plain(...args), sendDirectMessageWithLinkButton: (...args: unknown[]) => state.template(...args),
  sendDirectMessageWithButton: (...args: unknown[]) => state.button(...args), getUserFollowStatus: (...args: unknown[]) => state.follows(...args) }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}), getDMQueue: () => ({ add: state.queueAdd }),
  MESSAGE_JOB_NAME: "process-message", POSTBACK_JOB_NAME: "process-postback", FOLLOWUP_JOB_NAME: "process-followup" }));
vi.mock("bullmq", async original => ({ ...await original<typeof import("bullmq")>(), Worker: class {
  constructor(_name: string, processor: typeof state.processor) { state.processor = processor; }
  on() { return this; }
  async close() { /* No Redis connection was opened. */ }
} }));
import { createDMWorker } from "../lib/queue/dm-worker";
import { encryptToken } from "../lib/meta/oauth";
import { MetaApiError } from "../lib/meta/client";

let sql: Client;
function job(id: string): Job<DmQueueJob> {
  return { id, name: "process-message", attemptsMade: 0, data: { instagramAccountId: "fixture-ig", accountConnectionId: "fixture-connection",
    messageId: "fixture-same-inbound-message", messageText: "resgate", senderId: "fixture-recipient" } } as Job<DmQueueJob>;
}
async function bucket() { return state.db.commercialUsageBucket.findFirstOrThrow({ where: { resource: "DM" } }); }
describe.skipIf(!url)("commercial compound DM worker claims", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect(); await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma/migrations");
    for (const name of readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) await sql.query(readFileSync(path.join(root, name, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5, options: `-c search_path=${schema}` }, { schema }) });
    await sql.query(`CREATE FUNCTION "fixture_reject_sent_log"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."status"='SENT' THEN RAISE EXCEPTION 'fixture SENT log write unavailable'; END IF; RETURN NEW; END $$`);
  });
  beforeEach(async () => {
    vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("ENCRYPTION_KEY", "11".repeat(32)); vi.stubEnv("NEXTAUTH_SECRET", "fixture-tracking-secret");
    vi.stubEnv("NEXTAUTH_URL", "https://local.example.test");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Real provider HTTP forbidden"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    state.plain.mockReset().mockResolvedValue({ message_id: "fixture-plain-receipt" }); state.template.mockReset().mockResolvedValue({ message_id: "fixture-template-receipt" });
    state.button.mockReset().mockResolvedValue({ message_id: "fixture-button-receipt" }); state.follows.mockReset().mockResolvedValue(false); state.queueAdd.mockReset();
    await sql.query(`DROP TRIGGER IF EXISTS "fixture_sent_write_failure" ON "DmLog"`);
    await sql.query(`TRUNCATE TABLE "User", "Workspace", "PostbackDelivery", "CommercialUsageBucket" CASCADE`);
    await state.db.user.create({ data: { id: "fixture-owner", email: "fixture-owner@example.test" } });
    await state.db.workspace.create({ data: { id: "fixture-workspace", name: "Fixture", ownerId: "fixture-owner" } });
    const trialStartedAt = new Date(Date.now() - 60_000), trialEndsAt = new Date(trialStartedAt.getTime() + 72 * 3600_000);
    await state.db.trialRedemption.create({ data: { ownerId: "fixture-owner", trialStartedAt, trialEndsAt } });
    await state.db.workspaceBilling.create({ data: { workspaceId: "fixture-workspace", trialStartedAt, trialEndsAt } });
    await state.db.instagramAccount.create({ data: { id: "fixture-connection", workspaceId: "fixture-workspace", instagramId: "fixture-ig", username: "fixture", accessToken: encryptToken("fixture-provider-token") } });
    await state.db.automation.create({ data: { id: "fixture-automation", workspaceId: "fixture-workspace", instagramAccountId: "fixture-connection", name: "Fixture", keywords: ["resgate"], dmTriggerEnabled: true,
      dmMessage: "Fixture original campaign", trackedLinks: { create: { workspaceId: "fixture-workspace", slug: "fixture-tracked", destinationUrl: "https://example.test/fixture" } } } });
    createDMWorker();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => { await state.db?.$disconnect(); if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });

  it("holds one compound claim across rejected template and unknown fallback despite another queue ID/config/follow state", async () => {
    let releaseFallback!: () => void, fallbackEntered!: () => void;
    const blocked = new Promise<void>(resolve => { releaseFallback = resolve; }), entered = new Promise<void>(resolve => { fallbackEntered = resolve; });
    state.template.mockRejectedValue(new MetaApiError(100, undefined, undefined, "fixture button template rejected"));
    state.plain.mockImplementation(async () => { fallbackEntered(); await blocked; throw new Error("fixture fallback response lost"); });
    const first = state.processor(job("fixture-queue-first")).then(() => ({ status: "fulfilled" }), () => ({ status: "rejected" }));
    let firstResult: { status: string };
    try {
      await entered;
      expect(await state.db.postbackDelivery.count()).toBe(1);
      await state.db.automation.update({ where: { id: "fixture-automation" }, data: { dmMessage: "Fixture edited campaign", requireFollow: true } });
      await state.processor(job("fixture-queue-redelivered-different-id"));
      expect(state.template).toHaveBeenCalledOnce(); expect(state.plain).toHaveBeenCalledOnce(); expect(state.button).not.toHaveBeenCalled();
      expect(await state.db.commercialUsageReservation.count()).toBe(2);
    } finally { releaseFallback(); firstResult = await first; }
    expect(firstResult!).toEqual({ status: "rejected" });
    expect(await state.db.postbackDelivery.count()).toBe(1);
    expect(await state.db.commercialUsageReservation.count({ where: { status: "REJECTED" } })).toBe(1);
    expect(await state.db.commercialUsageReservation.count({ where: { status: "DISPATCHING" } })).toBe(1);
    expect(await bucket()).toMatchObject({ consumed: BigInt("0"), reserved: BigInt("1") });
    // Simulate missing log evidence after a crash: the independent claim stays.
    await state.db.dmLog.deleteMany(); await state.processor(job("fixture-third-queue-id-after-crash"));
    expect(state.template).toHaveBeenCalledOnce(); expect(state.plain).toHaveBeenCalledOnce(); expect(state.button).not.toHaveBeenCalled();
    expect(await state.db.postbackDelivery.count()).toBe(1); expect(await state.db.dmLog.count()).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("retains the independent claim when a real database SENT-log write fails after a confirmed send", async () => {
    await sql.query(`CREATE TRIGGER "fixture_sent_write_failure" BEFORE INSERT OR UPDATE ON "DmLog" FOR EACH ROW EXECUTE FUNCTION "fixture_reject_sent_log"()`);
    await expect(state.processor(job("fixture-log-write-failure"))).rejects.toBeDefined();
    expect(state.template).toHaveBeenCalledOnce(); expect(await state.db.postbackDelivery.count()).toBe(1);
    expect(await bucket()).toMatchObject({ consumed: BigInt("1"), reserved: BigInt("0") });
    await state.db.dmLog.deleteMany();
    await state.db.automation.update({ where: { id: "fixture-automation" }, data: { dmMessage: "Fixture changed after log loss" } });
    await state.processor(job("fixture-other-queue-id-log-missing"));
    expect(state.template).toHaveBeenCalledOnce(); expect(state.plain).not.toHaveBeenCalled();
    expect(await state.db.postbackDelivery.count()).toBe(1); expect(await state.db.commercialUsageReservation.count()).toBe(1);
  });
  it("releases a compound claim after a confirmed no-send rejection and allows one later retry", async () => {
    const rejection = new MetaApiError(551, undefined, undefined, "fixture definitive recipient rejection");
    state.template.mockRejectedValueOnce(rejection).mockResolvedValueOnce({ message_id: "fixture-retry-receipt" });
    await expect(state.processor(job("fixture-rejected-first"))).rejects.toBe(rejection);
    expect(await state.db.postbackDelivery.count()).toBe(0); expect(await bucket()).toMatchObject({ consumed: BigInt("0"), reserved: BigInt("0") });
    await state.processor(job("fixture-allowed-retry"));
    expect(state.template).toHaveBeenCalledTimes(2); expect(state.plain).not.toHaveBeenCalled();
    expect(await state.db.postbackDelivery.count()).toBe(1); expect(await bucket()).toMatchObject({ consumed: BigInt("1"), reserved: BigInt("0") });
    expect(await state.db.dmLog.findFirstOrThrow()).toMatchObject({ status: "SENT" });
  });
  it("preserves legacy behavior without creating a compound claim or commercial usage row when disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false"); await state.processor(job("fixture-legacy-job"));
    expect(state.template).toHaveBeenCalledOnce(); expect(await state.db.postbackDelivery.count()).toBe(0);
    expect(await state.db.commercialUsageReservation.count()).toBe(0); expect(await state.db.dmLog.findFirstOrThrow()).toMatchObject({ status: "SENT" });
  });
});
