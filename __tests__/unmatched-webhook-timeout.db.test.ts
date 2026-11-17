/** Native PostgreSQL lock/statement cancellation. Disposable schema only. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const schema = `webhook_timeout_${randomBytes(4).toString("hex")}`;
const applicationName = `test_${schema}`;
const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  queueAdd: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: state.queueAdd }), MESSAGE_JOB_NAME: "process-message", POSTBACK_JOB_NAME: "process-postback",
}));

const unmatched = { id: "unconnected", time: 1, messaging: [] };
const matched = { id: "connected", time: 1, messaging: [{
  sender: { id: "sender-test" }, recipient: { id: "connected" },
  message: { mid: "message-test", text: "message-test" },
}] };
const payload = { object: "instagram", entry: [unmatched, matched] };
let sql: Client;
let processWebhook: typeof import("@/lib/queue/process-webhook").processInstagramWebhook;
let unsupportedDiagnostic: typeof import("@/lib/queue/webhook-diagnostics").recordUnsupportedWebhookObject;
let recordDiagnostic: typeof import("@/lib/queue/webhook-diagnostics").recordUnmatchedWebhook;

// Test watchdog only: callers release the held lock and await the real query in
// finally, so reproducing the old bug never abandons a database operation.
async function within<T>(pending: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Diagnostic exceeded the test deadline")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

async function assertPoolUsableAndTimeoutsRestored() {
  const result = await state.db.$queryRaw<Array<{ value: number; statement: string; lock: string }>>`
    SELECT 1::int AS value, current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock
  `;
  expect(result).toEqual([{ value: 1, statement: "0", lock: "0" }]);
  const waiting = await sql.query("SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND (wait_event_type = 'Lock' OR state IN ('idle in transaction', 'idle in transaction (aborted)'))", [applicationName]);
  expect(waiting.rows).toEqual([]);
}

describe.skipIf(!DATABASE_URL)("bounded unmatched diagnostics on disposable PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: DATABASE_URL });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const migrations = path.join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(migrations, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      await sql.query(readFileSync(path.join(migrations, dir, "migration.sql"), "utf8"));
    // One connection makes a leaked diagnostic transaction immediately visible.
    state.db = new PrismaClient({ adapter: new PrismaPg({
      connectionString: DATABASE_URL, max: 1, application_name: applicationName,
      options: `-c search_path=${schema}`, connectionTimeoutMillis: 2_000,
    }, { schema }) });
    await state.db.user.create({ data: { id: "user" } });
    await state.db.workspace.create({ data: { id: "workspace", name: "test", ownerId: "user" } });
    await state.db.instagramAccount.create({ data: {
      id: "connection", workspaceId: "workspace", instagramId: "connected", username: "test", accessToken: "fake-test-token",
    } });
  });
  beforeEach(async () => {
    vi.resetModules();
    state.queueAdd.mockReset().mockResolvedValue({});
    await state.db.webhookEvent.deleteMany();
    await state.db.operationalEvent.deleteMany();
    processWebhook = (await import("@/lib/queue/process-webhook")).processInstagramWebhook;
    unsupportedDiagnostic = (await import("@/lib/queue/webhook-diagnostics")).recordUnsupportedWebhookObject;
    recordDiagnostic = (await import("@/lib/queue/webhook-diagnostics")).recordUnmatchedWebhook;
  });
  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("delivers and acknowledges a mixed payload while OperationalEvent remains locked", async () => {
    const locker = new Client({ connectionString: DATABASE_URL });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query(`LOCK TABLE "${schema}"."OperationalEvent" IN ACCESS EXCLUSIVE MODE`);
    const started = Date.now();
    const pending = processWebhook({ provider: "META", payload });
    void pending.catch(() => {});
    try {
      await within(pending, 2_000); // Must finish before releasing the diagnostic table lock.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(state.queueAdd).toHaveBeenCalledOnce();
      expect(await state.db.webhookEvent.findMany({ select: { status: true, workspaceId: true } })).toEqual([{ status: "PROCESSED", workspaceId: "workspace" }]);
      await assertPoolUsableAndTimeoutsRestored();
    } finally {
      await locker.query("ROLLBACK");
      await pending.catch(() => {});
      await locker.end();
    }
    expect(await state.db.operationalEvent.count()).toBe(0);
    await processWebhook({ provider: "META", payload });
    expect(state.queueAdd).toHaveBeenCalledTimes(2);
    expect(await state.db.operationalEvent.count()).toBe(0); // Failed sample still spends the budget.
  });

  it("cancels a slow diagnostic statement and releases the single pooled connection", async () => {
    await sql.query(`CREATE FUNCTION "${schema}".delay_diagnostic() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN NEW; END $$`);
    await sql.query(`CREATE TRIGGER slow_diagnostic BEFORE INSERT ON "${schema}"."OperationalEvent" FOR EACH ROW EXECUTE FUNCTION "${schema}".delay_diagnostic()`);
    try {
      const started = Date.now();
      await processWebhook({ provider: "META", payload });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(state.queueAdd).toHaveBeenCalledOnce();
      expect(await state.db.operationalEvent.count()).toBe(0);
      await assertPoolUsableAndTimeoutsRestored();
    } finally {
      await sql.query(`DROP TRIGGER slow_diagnostic ON "${schema}"."OperationalEvent"`);
      await sql.query(`DROP FUNCTION "${schema}".delay_diagnostic()`);
    }
  });

  it("bounds acquisition when the pool is busy and rolls back a late transaction", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const holder = state.db.$transaction(async () => { acquired(); await hold; });
    await ready;
    try {
      const started = Date.now();
      await recordDiagnostic({ provider: "META", incoming: payload, unmatched: [unmatched] });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      release();
      await holder;
    }
    await assertPoolUsableAndTimeoutsRestored();
    expect(await state.db.operationalEvent.count()).toBe(0);
  });
  it("bounds unsupported-object diagnostics under a PostgreSQL lock and spends the failed budget", async () => {
    const locker = new Client({ connectionString: DATABASE_URL });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query(`LOCK TABLE "${schema}"."OperationalEvent" IN ACCESS EXCLUSIVE MODE`);
    const args = { provider: "META" as const, object: "page", entries: [] };
    const pending = unsupportedDiagnostic(args);
    void pending.catch(() => {});
    try {
      await within(pending, 2_000);
      await assertPoolUsableAndTimeoutsRestored();
    } finally {
      await locker.query("ROLLBACK");
      await pending.catch(() => {});
      await locker.end();
    }
    await unsupportedDiagnostic(args);
    expect(await state.db.operationalEvent.count()).toBe(0);
  });

});
