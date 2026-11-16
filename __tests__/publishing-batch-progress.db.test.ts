/** Real PostgreSQL MVCC/row-lock regression. Disposable DB only; own schema. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const schema = `batch_progress_${randomBytes(4).toString("hex")}`;
const applicationName = `test_${schema}`;
type TestJob = { id: string; data: { publicationId: string; workspaceId: string }; attemptsMade: number; opts: { attempts: number } };
const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  processor: undefined as unknown as (job: TestJob) => Promise<void>,
  failed: undefined as unknown as (job: TestJob, error: Error) => void,
  publishContainer: vi.fn(async () => "media_progress_test"),
}));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/instagram/context", () => ({ createInstagramContext: async () => ({ provider: "META", instagramId: "instagram_a", accessToken: "fake-test-token" }) }));
vi.mock("@/lib/instagram/publish-content", () => ({
  assertContentPublishPermission: async () => {},
  getContentPublishingLimit: async () => ({ quotaUsage: 0, quotaTotal: 100 }),
  createPublishContainer: vi.fn(),
  waitForContainer: async () => ({ status_code: "FINISHED" }),
  publishContainer: state.publishContainer,
}));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("bullmq", () => ({ Worker: class {
  constructor(_name: string, processor: typeof state.processor) { state.processor = processor; }
  on(event: string, handler: typeof state.failed) {
    if (event === "failed") state.failed = handler;
    return this;
  }
} }));
import { refreshBatchProgress } from "@/lib/queue/publishing-batch-progress";
import * as progress from "@/lib/queue/publishing-batch-progress";
import { createPublishingWorker } from "@/lib/queue/publishing-worker";

let sql: Client;
const date = new Date("2030-01-01T10:00:00Z");

async function batch(id: string, tenant: "a" | "b" = "a", totalItems = 1, status: "RUNNING" | "PAUSED" | "CANCELLED" = "RUNNING") {
  return state.db.speedPostBatch.create({ data: {
    id, workspaceId: `workspace_${tenant}`, instagramAccountId: `account_${tenant}`, name: id,
    status, totalItems, postsPerDay: 1, scheduleMode: "FIXED", orderMode: "MANUAL", timezone: "UTC", timeSlots: ["10:00"], startsOn: date,
  } });
}
async function publication(id: string, batchId: string, status: "PROCESSING" | "PUBLISHED" | "FAILED" = "PUBLISHED", tenant: "a" | "b" = "a") {
  return state.db.scheduledPublication.create({ data: {
    id, batchId, workspaceId: `workspace_${tenant}`, instagramAccountId: `account_${tenant}`,
    type: "REEL", timezone: "UTC", status, idempotencyKey: id,
  } });
}
async function waitForRefreshLock() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await sql.query("SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [applicationName]);
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Refresh did not reach the locked batch row");
}

describe.skipIf(!DATABASE_URL)("Speed Post batch progress on disposable PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: DATABASE_URL });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const migrations = path.join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(migrations, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      await sql.query(readFileSync(path.join(migrations, dir, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({
      connectionString: DATABASE_URL, application_name: applicationName,
      options: `-c search_path=${schema}`,
    }, { schema }) });
    for (const tenant of ["a", "b"]) {
      await state.db.user.create({ data: { id: `user_${tenant}` } });
      await state.db.workspace.create({ data: { id: `workspace_${tenant}`, name: tenant, ownerId: `user_${tenant}` } });
      await state.db.instagramAccount.create({ data: { id: `account_${tenant}`, workspaceId: `workspace_${tenant}`, instagramId: `instagram_${tenant}`, username: tenant, accessToken: "fake-test-token" } });
    }
  });
  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });
  beforeEach(async () => {
    state.publishContainer.mockClear();
    await state.db.scheduledPublication.deleteMany();
    await state.db.speedPostBatch.deleteMany();
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not overwrite cancellation committed while refresh waits for the batch row", async () => {
    await batch("cancel_race");
    await publication("published", "cancel_race");
    const cancel = new Client({ connectionString: DATABASE_URL });
    await cancel.connect();
    await cancel.query("BEGIN");
    await cancel.query(`UPDATE "${schema}"."SpeedPostBatch" SET status = 'CANCELLED' WHERE id = $1 AND "workspaceId" = $2`, ["cancel_race", "workspace_a"]);
    const refresh = refreshBatchProgress("cancel_race", "workspace_a");
    void refresh.catch(() => {});
    try {
      await waitForRefreshLock();
      await cancel.query("COMMIT");
      await refresh;
      const result = await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "cancel_race" } });
      expect(result.status).toBe("CANCELLED");
      expect(result.completedAt).toBeNull();
    } finally {
      await cancel.query("ROLLBACK");
      await refresh.catch(() => {});
      await cancel.end();
    }
  });

  it("finishes with authoritative counts after concurrent publication completions", async () => {
    await batch("parallel", "a", 10);
    for (let index = 0; index < 10; index += 1) await publication(`item_${index}`, "parallel", "PROCESSING");
    await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      await state.db.scheduledPublication.update({ where: { id: `item_${index}` }, data: { status: index === 9 ? "FAILED" : "PUBLISHED" } });
      await refreshBatchProgress("parallel", "workspace_a");
    }));
    const result = await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "parallel" } });
    expect(result).toEqual(expect.objectContaining({ publishedItems: 9, failedItems: 1, status: "FAILED" }));
    expect(result.completedAt).not.toBeNull();
  });

  it("preserves an incomplete pause but lets the final in-flight publication complete", async () => {
    await batch("paused", "a", 2, "PAUSED");
    await publication("first", "paused");
    await publication("last", "paused", "PROCESSING");
    await refreshBatchProgress("paused", "workspace_a");
    expect(await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "paused" } })).toEqual(expect.objectContaining({ status: "PAUSED", publishedItems: 1, completedAt: null }));
    await state.db.scheduledPublication.update({ where: { id: "last" }, data: { status: "PUBLISHED" } });
    await refreshBatchProgress("paused", "workspace_a");
    expect(await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "paused" } })).toEqual(expect.objectContaining({ status: "COMPLETED", publishedItems: 2 }));
  });

  it("does not modify another workspace's batch or a missing batch", async () => {
    await batch("tenant_b", "b");
    await publication("published_b", "tenant_b", "PUBLISHED", "b");
    const before = await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "tenant_b" } });
    await refreshBatchProgress("tenant_b", "workspace_a");
    await refreshBatchProgress("missing", "workspace_a");
    await refreshBatchProgress(null, "workspace_a");
    expect(await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "tenant_b" } })).toEqual(before);
  });

  it("excludes cross-workspace publications even when they reference this workspace's batch", async () => {
    await batch("aggregate_a", "a", 2);
    await publication("a_published", "aggregate_a");
    await publication("a_processing", "aggregate_a", "PROCESSING");
    // The current foreign keys permit this inconsistent legacy/import shape.
    // The aggregate must still enforce workspace ownership for both statuses.
    await publication("b_published", "aggregate_a", "PUBLISHED", "b");
    await publication("b_failed", "aggregate_a", "FAILED", "b");
    await refreshBatchProgress("aggregate_a", "workspace_a");
    expect(await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "aggregate_a" } })).toEqual(expect.objectContaining({
      publishedItems: 1, failedItems: 0, status: "RUNNING", completedAt: null,
    }));
  });

  it("keeps a published row through progress failure, final failed handler, and retry without republishing", async () => {
    await batch("progress_failure");
    await publication("already_published", "progress_failure", "PROCESSING");
    await state.db.scheduledPublication.update({ where: { id: "already_published" }, data: { metaContainerId: "container_progress_test" } });
    const actualRefresh = progress.refreshBatchProgress;
    const error = new Error("Progress transaction unavailable");
    let finishFailedHandler!: () => void;
    const failedHandlerFinished = new Promise<void>((resolve) => { finishFailedHandler = resolve; });
    vi.spyOn(progress, "refreshBatchProgress").mockRejectedValueOnce(error).mockImplementationOnce(async (...args) => {
      try { await actualRefresh(...args); } finally { finishFailedHandler(); }
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    createPublishingWorker();
    const job: TestJob = { id: "progress_job", data: { publicationId: "already_published", workspaceId: "workspace_a" }, attemptsMade: 5, opts: { attempts: 5 } };

    await expect(state.processor(job)).rejects.toThrow(error.message);
    const published = await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: job.data.publicationId } });
    expect(published).toEqual(expect.objectContaining({ status: "PUBLISHED", metaMediaId: "media_progress_test" }));
    state.failed(job, error);
    await failedHandlerFinished;
    await expect(state.processor(job)).resolves.toBeUndefined();

    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: job.data.publicationId } })).toEqual(published);
    expect(state.publishContainer).toHaveBeenCalledOnce();
    expect(await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "progress_failure" } })).toEqual(expect.objectContaining({
      publishedItems: 1, failedItems: 0, status: "COMPLETED",
    }));
  });
});
