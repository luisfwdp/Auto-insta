/** Native worker/ledger composition on disposable PostgreSQL. Meta responses
 * are fixtures and establish no claim of real publication or delivery. */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type TestJob = { data: { workspaceId: string; publicationId: string } };
const url = process.env.TEST_DATABASE_URL, schema = `publishing_commercial_${randomBytes(5).toString("hex")}`;
const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  processor: undefined as unknown as (job: TestJob) => Promise<void>,
  wait: vi.fn(), publish: vi.fn(), sign: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/instagram/context", () => ({ createInstagramContext: async () => ({ provider: "META", instagramId: "instagram", accessToken: "fake-native-test-token" }) }));
vi.mock("@/lib/billing/commercial-capacity", () => ({ assertCommercialAccountUsable: async () => {} }));
vi.mock("@/lib/instagram/publish-content", () => ({
  assertContentPublishPermission: async () => {},
  getContentPublishingLimit: async () => ({ quotaUsage: 0, quotaTotal: 100 }),
  createPublishContainer: async () => "new_container",
  waitForContainer: state.wait, publishContainer: state.publish,
}));
vi.mock("@/lib/publishing/storage", () => ({ createSignedDownload: state.sign }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("bullmq", () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
  Worker: class {
    constructor(_name: string, processor: typeof state.processor) { state.processor = processor; }
    on() { return this; }
  },
}));
import { createPublishingWorker } from "../lib/queue/publishing-worker";
import { reserveCommercialUsage, beginCommercialDispatch, finishCommercialDispatch } from "../lib/billing/commercial-usage";
import { RateLimitError } from "../lib/meta/client";

let sql: Client, trialEndsAt: Date;
const job = (id: string) => ({ data: { workspaceId: "workspace", publicationId: id } });
async function publication(id: string, batchId?: string) {
  return state.db.scheduledPublication.create({ data: {
    id, workspaceId: "workspace", instagramAccountId: "account", batchId, type: "REEL", timezone: "UTC",
    status: "QUEUED", idempotencyKey: id, metaContainerId: `container_${id}`,
  } });
}
async function allowance(key: string, amount = 1) {
  const reservation = await reserveCommercialUsage("workspace", "PUBLICATION", key, amount);
  if (!reservation.reservationId) throw new Error("Expected commercial fixture");
  return reservation.reservationId;
}

describe.skipIf(!url)("commercial publication dispatch on isolated PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const migrations = path.join(__dirname, "..", "prisma", "migrations");
    for (const directory of readdirSync(migrations, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort())
      await sql.query(readFileSync(path.join(migrations, directory, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5, options: `-c search_path=${schema}` }, { schema }) });
    await state.db.user.create({ data: { id: "owner" } });
    await state.db.workspace.create({ data: { id: "workspace", name: "Test", ownerId: "owner" } });
    await state.db.instagramAccount.create({ data: { id: "account", workspaceId: "workspace", instagramId: "instagram", username: "test", accessToken: "fixture-only" } });
    createPublishingWorker();
  });
  beforeEach(async () => {
    vi.resetAllMocks(); vi.stubEnv("BILLING_ENABLED", "true");
    await sql.query(`TRUNCATE TABLE "CommercialUsageReservation", "CommercialUsageBucket", "ScheduledPublication", "SpeedPostBatch", "WorkspaceBilling", "TrialRedemption" CASCADE`);
    const trialStartedAt = new Date(Date.now() - 60000); trialEndsAt = new Date(trialStartedAt.getTime() + 72 * 3600000);
    await state.db.trialRedemption.create({ data: { ownerId: "owner", trialStartedAt, trialEndsAt } });
    await state.db.workspaceBilling.create({ data: { workspaceId: "workspace", trialStartedAt, trialEndsAt } });
    state.wait.mockResolvedValue({ status_code: "FINISHED" });
    state.publish.mockResolvedValue("fixture_media");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll(async () => {
    vi.unstubAllEnvs(); await state.db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });

  it("admits exactly one publication when concurrent jobs compete for the last allowance", async () => {
    const previous = await allowance("previous_usage", 9), claim = await beginCommercialDispatch("workspace", previous);
    await finishCommercialDispatch("workspace", previous, claim!.dispatchToken, "CONFIRMED");
    await publication("one"); await publication("two");
    const results = await Promise.allSettled([state.processor(job("one")), state.processor(job("two"))]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toMatchObject([{ reason: { message: "COMMERCIAL_QUOTA_EXCEEDED" } }]);
    expect(state.publish).toHaveBeenCalledOnce();
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(10), reserved: BigInt(0) });
    expect(await state.db.scheduledPublication.count({ where: { status: "PUBLISHED" } })).toBe(1);
    expect(await state.db.scheduledPublication.count({ where: { status: "FAILED", lastError: "COMMERCIAL_QUOTA_EXCEEDED" } })).toBe(1);
  });

  it("retains unknown outcomes across replays and commits only canonical PUBLISHED recovery after expiry", async () => {
    await publication("unknown");
    state.publish.mockRejectedValueOnce(new TypeError("fixture network interruption"));
    await expect(state.processor(job("unknown"))).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
    expect(await state.db.commercialUsageReservation.findFirstOrThrow()).toMatchObject({ status: "DISPATCHING" });
    await state.db.scheduledPublication.update({ where: { id: "unknown" }, data: { status: "QUEUED" } });
    await expect(state.processor(job("unknown"))).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
    expect(state.publish).toHaveBeenCalledOnce();
    await state.db.scheduledPublication.update({ where: { id: "unknown" }, data: { status: "QUEUED" } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(trialEndsAt.getTime() + 1);
    state.wait.mockResolvedValue({ status_code: "PUBLISHED" });
    await state.processor(job("unknown")); await state.processor(job("unknown"));
    expect(state.publish).toHaveBeenCalledOnce();
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(1), reserved: BigInt(0) });
    expect(await state.db.commercialUsageReservation.findFirstOrThrow()).toMatchObject({ status: "COMMITTED" });
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "unknown" } })).toMatchObject({ status: "PUBLISHED", metaStatus: "PUBLISHED_RECOVERED", metaMediaId: null });
  });

  it("retries a proven rate-limit rejection in the last slot and recovers a lost local write without another allocation", async () => {
    const previous = await allowance("previous_usage", 9), previousClaim = await beginCommercialDispatch("workspace", previous);
    await finishCommercialDispatch("workspace", previous, previousClaim!.dispatchToken, "CONFIRMED");
    await publication("retry_rejected");
    const rejection = new RateLimitError("fixture Meta rejection");
    state.publish.mockRejectedValueOnce(rejection);
    await expect(state.processor(job("retry_rejected"))).rejects.toBe(rejection);
    const rejected = await state.db.commercialUsageReservation.findFirstOrThrow({ where: { operationKey: "retry_rejected" } });
    expect(rejected.status).toBe("REJECTED");
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ reserved: BigInt(0), consumed: BigInt(9) });
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "retry_rejected" } })).toMatchObject({ status: "PROCESSING" });

    const updateMany = state.db.scheduledPublication.updateMany.bind(state.db.scheduledPublication);
    let lostWrite = false;
    vi.spyOn(state.db.scheduledPublication, "updateMany").mockImplementation(args => {
      if (args.data.status === "PUBLISHED" && !lostWrite) { lostWrite = true; throw new Error("fixture local publication write lost"); }
      return updateMany(args);
    });
    await expect(state.processor(job("retry_rejected"))).rejects.toThrow("fixture local publication write lost");
    expect(await state.db.commercialUsageReservation.findFirstOrThrow({ where: { operationKey: "retry_rejected" } })).toMatchObject({ id: rejected.id, status: "COMMITTED" });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ reserved: BigInt(0), consumed: BigInt(10) });
    expect(await state.db.commercialUsageReservation.count()).toBe(2);

    // The successful effect is already charged, and now every allowance is
    // used. Canonical recovery still needs no fresh reservation/access grant.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(trialEndsAt.getTime() + 1);
    state.wait.mockResolvedValue({ status_code: "PUBLISHED" });
    await state.processor(job("retry_rejected")); await state.processor(job("retry_rejected"));
    expect(state.publish).toHaveBeenCalledTimes(2); // one rejection, one success
    expect(await state.db.commercialUsageReservation.count()).toBe(2);
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ reserved: BigInt(0), consumed: BigInt(10) });
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "retry_rejected" } })).toMatchObject({ status: "PUBLISHED" });
  });

  it("honors a cancellation committed during container processing and returns the unused hold", async () => {
    await state.db.speedPostBatch.create({ data: { id: "batch", workspaceId: "workspace", instagramAccountId: "account", name: "Test", status: "RUNNING",
      postsPerDay: 1, scheduleMode: "FIXED", orderMode: "SEQUENTIAL", timezone: "UTC", timeSlots: ["10:00"], startsOn: new Date(), totalItems: 1 } });
    await publication("cancelled", "batch");
    state.wait.mockImplementationOnce(async () => {
      await state.db.speedPostBatch.update({ where: { id: "batch" }, data: { status: "CANCELLED" } });
      return { status_code: "FINISHED" };
    });
    await state.processor(job("cancelled"));
    expect(state.publish).not.toHaveBeenCalled();
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "cancelled" } })).toMatchObject({ status: "CANCELLED" });
    expect(await state.db.commercialUsageReservation.findFirstOrThrow()).toMatchObject({ status: "RELEASED" });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(0), reserved: BigInt(0) });
  });

  it("rechecks the actual trial clock after waiting without reserving or publishing", async () => {
    await publication("expired");
    state.wait.mockImplementationOnce(async () => {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(trialEndsAt.getTime() + 1);
      return { status_code: "FINISHED" };
    });
    await expect(state.processor(job("expired"))).rejects.toThrow("COMMERCIAL_ACCESS_REQUIRED");
    expect(state.publish).not.toHaveBeenCalled();
    expect(await state.db.commercialUsageReservation.count()).toBe(0);
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "expired" } })).toMatchObject({ status: "FAILED", metaContainerId: "container_expired" });
  });

  it("performs no commercial database transaction when billing is disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false"); await publication("legacy");
    const transaction = vi.spyOn(state.db, "$transaction");
    await state.processor(job("legacy"));
    expect(transaction).not.toHaveBeenCalled();
    expect(state.publish).toHaveBeenCalledOnce();
    expect(await state.db.commercialUsageReservation.count()).toBe(0);
  });
});
