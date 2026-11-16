/** Real PostgreSQL MVCC/row-lock regression. Disposable DB only; own schema. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const schema = `batch_progress_${randomBytes(4).toString("hex")}`;
const applicationName = `test_${schema}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { refreshBatchProgress } from "@/lib/queue/publishing-batch-progress";

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
    await state.db.scheduledPublication.deleteMany();
    await state.db.speedPostBatch.deleteMany();
  });

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
});
