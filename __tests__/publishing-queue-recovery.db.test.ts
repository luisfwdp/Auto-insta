/** Disposable Postgres only: each run creates/drops its own schema from migrations. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const schema = `publishing_recovery_${randomBytes(4).toString("hex")}`;
const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  getJob: vi.fn(), add: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: class { getJob = state.getJob; add = state.add; } }));

import { recoverQueuedPublications } from "@/lib/queue/publishing";

const now = new Date("2030-01-01T10:00:00Z");
const old = new Date("2030-01-01T09:00:00Z");
let sql: Client;

async function publication(id: string, workspaceId = "workspace_a", extra = {}) {
  return state.db.scheduledPublication.create({ data: {
    id, workspaceId, instagramAccountId: `account_${workspaceId.at(-1)}`,
    type: "REEL", timezone: "UTC", status: "QUEUED", idempotencyKey: id,
    scheduledFor: old, updatedAt: old, ...extra,
  } });
}

describe.skipIf(!DATABASE_URL)("queued publication recovery on disposable Postgres", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: DATABASE_URL });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const migrations = path.join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(migrations).sort()) {
      if (dir === "migration_lock.toml") continue;
      await sql.query(readFileSync(path.join(migrations, dir, "migration.sql"), "utf8"));
    }
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema }) });
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
    vi.clearAllMocks();
    state.getJob.mockResolvedValue(undefined);
    state.add.mockResolvedValue({});
    await state.db.scheduledPublication.deleteMany();
    await state.db.speedPostBatch.deleteMany();
  });

  it("recovers missing jobs once across two replicas and preserves each tenant payload", async () => {
    await publication("missing_a", "workspace_a", { scheduledFor: null });
    await publication("missing_b", "workspace_b");
    const results = await Promise.all([recoverQueuedPublications(now), recoverQueuedPublications(now)]);
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(state.add).toHaveBeenCalledTimes(2);
    expect(state.add).toHaveBeenCalledWith(expect.any(String), { publicationId: "missing_a", workspaceId: "workspace_a" }, expect.objectContaining({ jobId: "publication_missing_a" }));
    expect(state.add).toHaveBeenCalledWith(expect.any(String), { publicationId: "missing_b", workspaceId: "workspace_b" }, expect.objectContaining({ jobId: "publication_missing_b" }));
  });

  it("does not recover fresh claims, future items, terminal items, or paused/cancelled batches", async () => {
    await publication("fresh", "workspace_a", { updatedAt: now });
    await publication("future", "workspace_a", { scheduledFor: new Date("2030-01-02T10:00:00Z") });
    await publication("cancelled", "workspace_a", { status: "CANCELLED" });
    await publication("published", "workspace_a", { status: "PUBLISHED" });
    for (const status of ["PAUSED", "CANCELLED"] as const) {
      const batch = await state.db.speedPostBatch.create({ data: {
        id: status, workspaceId: "workspace_a", instagramAccountId: "account_a", name: status,
        status, postsPerDay: 1, scheduleMode: "FIXED", orderMode: "MANUAL", timezone: "UTC", timeSlots: ["10:00"], startsOn: old,
      } });
      await publication(`item_${status}`, "workspace_a", { batchId: batch.id });
    }
    expect(await recoverQueuedPublications(now)).toBe(0);
    expect(state.getJob).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("rotates existing-job inspections so the scan limit does not hide later orphans", async () => {
    await publication("existing", "workspace_a", { updatedAt: new Date(old.getTime() - 1000) });
    await publication("missing");
    state.getJob.mockResolvedValueOnce({ id: "existing" }).mockResolvedValue(undefined);
    expect(await recoverQueuedPublications(now, 1)).toBe(0);
    expect(await recoverQueuedPublications(now, 1)).toBe(1);
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenCalledWith(expect.any(String), { publicationId: "missing", workspaceId: "workspace_a" }, expect.any(Object));
  });
});
