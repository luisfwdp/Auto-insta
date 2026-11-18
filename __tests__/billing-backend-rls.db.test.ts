/** Local PostgreSQL only. Unique NOLOGIN roles/schemas; no shared API-role edits.
 * Only the fixed backend role literal is replaced in the migration fixture. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const url = process.env.TEST_DATABASE_URL, suffix = randomBytes(6).toString("hex");
const schemas = [`backend_denied_${suffix}`, `backend_allowed_${suffix}`];
const backend = `billing_backend_${suffix}`;
const negatives = ["anon", "authenticated", "service_role", "untrusted"].map(role => `billing_${role}_${suffix}`);
const roles = [backend, ...negatives];
const tables = ["WorkspaceBilling", "TrialRedemption", "BillingCheckout", "BillingSubscription", "BillingPayment", "BillingEvent", "BillingCommand", "CommercialUsageBucket", "CommercialUsageReservation"];
const migrationName = "20261118140000_backend_billing_rls";
const migration = readFileSync(path.join(__dirname, "..", "prisma/migrations", migrationName, "migration.sql"), "utf8");
const state = vi.hoisted(() => ({ db: undefined as unknown as PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { startCardFreeTrial } from "../lib/billing/trial";
import { reserveCommercialUsage, beginCommercialDispatch, finishCommercialDispatch } from "../lib/billing/commercial-usage";
let sql: Client;
const admins: PrismaClient[] = [], runtimes: PrismaClient[] = [];
const createdRoles: string[] = [], createdSchemas: string[] = [];
const scope = "12000000-0000-4000-8000-000000000001";
function fixtureMigration(role = backend) {
  if (migration.split("'pingchat_runtime'").length !== 2) throw new Error("Expected exactly one backend role literal");
  return migration.replace("'pingchat_runtime'", `'${role}'`);
}
async function newWorkspace(db: PrismaClient, id: string) {
  await db.user.create({ data: { id: `owner-${id}`, email: `${id}@example.test` } });
  await db.workspace.create({ data: { id, name: id, ownerId: `owner-${id}` } });
}
async function financialRows(db: PrismaClient, workspaceId: string) {
  const checkout = await db.billingCheckout.create({ data: { workspaceId, environment: "sandbox", accountScope: scope, requestId: randomUUID(), planId: "pro-v1", amountCents: 14900, firstChargeDate: "2026-11-18", billingAnchorDay: 18 } });
  const subscription = await db.billingSubscription.create({ data: { workspaceId, environment: "sandbox", accountScope: scope, providerSubscriptionId: `sub_${randomUUID()}`, providerCustomerId: "cus_fixture", checkoutId: checkout.id, planId: "pro-v1", amountCents: 14900, billingAnchorDay: 18, renewalStatus: "ACTIVE" } });
  await db.billingPayment.create({ data: { workspaceId, environment: "sandbox", accountScope: scope, subscriptionId: subscription.id, providerPaymentId: `pay_${randomUUID()}`, amountCents: 14900, dueDate: "2026-11-18", status: "CONFIRMED", deleted: false } });
  await db.billingEvent.create({ data: { environment: "sandbox", accountScope: scope, eventId: `evt_${randomUUID()}`, eventType: "PAYMENT_CONFIRMED" } });
  await db.billingCommand.create({ data: { workspaceId, subscriptionId: subscription.id, requestId: randomUUID() } });
  return subscription;
}
async function asRole<T>(role: string, schema: string, run: () => Promise<T>) {
  await sql.query(`SET search_path TO "${schema}"`); await sql.query(`SET ROLE "${role}"`);
  try { return await run(); } finally { await sql.query("RESET ROLE"); }
}

describe.skipIf(!url)("trusted backend billing RLS policies", () => {
  beforeAll(async () => {
    vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scope);
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("FLY_APP_NAME", ""); vi.stubEnv("ENCRYPTION_KEY", "11".repeat(32));
    sql = new Client({ connectionString: url }); await sql.connect();
    for (const role of roles) { await sql.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`); createdRoles.push(role); }
    for (const [index, schema] of schemas.entries()) {
      await sql.query(`CREATE SCHEMA "${schema}"`); createdSchemas.push(schema); await sql.query(`SET search_path TO "${schema}"`);
      const root = path.join(__dirname, "..", "prisma/migrations");
      for (const name of readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort()) {
        if (name !== migrationName) await sql.query(readFileSync(path.join(root, name, "migration.sql"), "utf8"));
      }
      const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: `-c search_path=${schema}` }, { schema }) }); admins.push(admin);
      state.db = admin;
      for (const id of ["seed-a", "seed-b"]) { await newWorkspace(admin, id); await startCardFreeTrial(id); }
      await financialRows(admin, "seed-a");
      await reserveCommercialUsage("seed-a", "DM", "seed-ledger");
      await sql.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${roles.map(role => `"${role}"`).join(",")}`);
      // Reproduce existing trusted runtime DML ACLs; the migration adds no grants.
      await sql.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${backend}"`);
      for (const role of negatives) await sql.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${tables.map(table => `"${table}"`).join(",")} TO "${role}"`);
      if (index === 1) await sql.query(fixtureMigration());
      runtimes.push(new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10, options: `-c search_path=${schema} -c role=${backend}` }, { schema }) }));
    }
  });
  beforeEach(() => { state.db = runtimes[1]; });
  afterAll(async () => {
    vi.unstubAllEnvs(); await Promise.all([...runtimes, ...admins].map(db => db.$disconnect()));
    if (sql) {
      await sql.query("RESET ROLE");
      for (const schema of createdSchemas) await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
      for (const role of createdRoles) await sql.query(`DROP ROLE "${role}"`);
      await sql.end();
    }
  });

  it("proves the original non-owner runtime sees no rows and cannot start a trial despite DML grants", async () => {
    await asRole(backend, schemas[0], async () => {
      for (const table of tables) expect((await sql.query(`SELECT * FROM "${table}"`)).rowCount).toBe(0);
      await expect(sql.query(`INSERT INTO "BillingEvent" (id,environment,"accountScope","eventId","eventType","updatedAt") VALUES ($1,'sandbox',$2,'denied','PAYMENT_CONFIRMED',now())`, [randomUUID(), scope])).rejects.toMatchObject({ code: "42501" });
    });
    state.db = runtimes[0];
    await expect(startCardFreeTrial("seed-a")).rejects.toThrow();
    expect(await admins[0].trialRedemption.count()).toBe(2);
  });
  it("starts a three-day card-free trial using only the non-owner runtime", async () => {
    await newWorkspace(admins[1], "runtime-trial");
    const first = await startCardFreeTrial("runtime-trial"), repeat = await startCardFreeTrial("runtime-trial");
    expect(first).toEqual(repeat); expect(first.status).toBe("TRIALING"); expect(first.hasAccess).toBe(true);
    expect(Date.parse(first.trialEndsAt!) - Date.parse(first.trialStartedAt!)).toBe(72 * 3600000);
    expect(await state.db.trialRedemption.count({ where: { ownerId: "owner-runtime-trial" } })).toBe(1);
    expect(await state.db.billingCheckout.count({ where: { workspaceId: "runtime-trial" } })).toBe(0);
  });
  it("runs financial inbox/outbox, ledger claims and quota enforcement as the runtime", async () => {
    await newWorkspace(admins[1], "runtime-ledger"); await startCardFreeTrial("runtime-ledger");
    const sub = await financialRows(state.db, "runtime-ledger");
    await state.db.billingSubscription.update({ where: { id: sub.id }, data: { renewalStatus: "CANCELED" } });
    await state.db.billingPayment.updateMany({ where: { workspaceId: "runtime-ledger" }, data: { status: "RECEIVED" } });
    await state.db.billingEvent.updateMany({ where: { eventType: "PAYMENT_CONFIRMED" }, data: { status: "PROCESSED" } });
    await state.db.billingCommand.updateMany({ where: { workspaceId: "runtime-ledger" }, data: { status: "PROCESSED" } });
    const row = await reserveCommercialUsage("runtime-ledger", "DM", "real-runtime-ledger", 100);
    const claim = await beginCommercialDispatch("runtime-ledger", row.reservationId!);
    expect(claim).not.toBeNull();
    expect(await finishCommercialDispatch("runtime-ledger", row.reservationId!, claim!.dispatchToken, "CONFIRMED", { messageId: "fixture-confirmed-receipt" })).toBe(true);
    await expect(reserveCommercialUsage("runtime-ledger", "DM", "over-quota")).rejects.toMatchObject({ code: "COMMERCIAL_QUOTA_EXCEEDED" });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow({ where: { subjectId: "owner-runtime-ledger" } })).toMatchObject({ reserved: BigInt("0"), consumed: BigInt("100") });
    // A trusted worker intentionally serves multiple tenants; app code owns scope.
    expect(await state.db.workspaceBilling.count({ where: { workspaceId: { in: ["seed-a", "seed-b"] } } })).toBe(2);
    await asRole(backend, schemas[1], async () => {
      for (const table of tables) expect((await sql.query(`SELECT * FROM "${table}"`)).rowCount).toBeGreaterThan(0);
    });
  });
  it.each(negatives)("still hides all nine tables from granted but untrusted role %s", async role => {
    await asRole(role, schemas[1], async () => {
      for (const table of tables) {
        expect((await sql.query(`SELECT * FROM "${table}"`)).rowCount).toBe(0);
        expect((await sql.query(`DELETE FROM "${table}"`)).rowCount).toBe(0);
        const key = table === "WorkspaceBilling" ? "workspaceId" : table === "TrialRedemption" ? "ownerId" : "id";
        expect((await sql.query(`UPDATE "${table}" SET "${key}"="${key}"`)).rowCount).toBe(0);
      }
      await expect(sql.query(`INSERT INTO "BillingEvent" (id,environment,"accountScope","eventId","eventType","updatedAt") VALUES ($1,'sandbox',$2,'negative','PAYMENT_CONFIRMED',now())`, [randomUUID(), scope])).rejects.toMatchObject({ code: "42501" });
    });
  });
  it("adds exactly nine role-specific policies without changing ACL, ownership, RLS or role attributes", async () => {
    const policies = (await sql.query(`SELECT tablename,roles::text[] AS roles,cmd,qual,with_check FROM pg_policies WHERE schemaname=$1 ORDER BY tablename`, [schemas[1]])).rows;
    expect(policies).toHaveLength(9);
    expect(policies.map(row => row.tablename).sort()).toEqual([...tables].sort());
    for (const policy of policies) expect(policy).toMatchObject({ roles: [backend], cmd: "ALL", qual: "true", with_check: "true" });
    const attrs = (await sql.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolcanlogin,rolbypassrls FROM pg_roles WHERE rolname=$1`, [backend])).rows[0];
    expect(Object.values(attrs).every(value => value === false)).toBe(true);
    const catalog = (await sql.query(`SELECT n.nspname,c.relname,c.relowner,c.relacl::text,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relname=ANY($2::text[])`, [schemas, tables])).rows;
    for (const table of tables) {
      const before = catalog.find(row => row.nspname === schemas[0] && row.relname === table), after = catalog.find(row => row.nspname === schemas[1] && row.relname === table);
      expect(after.relowner).toBe(before.relowner); expect(after.relacl).toBe(before.relacl); expect(after.relrowsecurity).toBe(true);
      const acl = await sql.query(`SELECT EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee=0) AS public_access FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`, [schemas[1], table]);
      expect(acl.rows[0].public_access).toBe(false);
    }
  });
  it("retains DDL/TRUNCATE restrictions and cannot bypass RLS by disabling row_security", async () => {
    await asRole(backend, schemas[1], async () => {
      await expect(sql.query('ALTER TABLE "BillingEvent" DISABLE ROW LEVEL SECURITY')).rejects.toMatchObject({ code: "42501" });
      await expect(sql.query('TRUNCATE "BillingEvent"')).rejects.toMatchObject({ code: "42501" });
      await expect(sql.query('CREATE TABLE "runtime_cannot_create" (id int)')).rejects.toMatchObject({ code: "42501" });
    });
    await asRole(backend, schemas[0], async () => {
      await sql.query("SET row_security = off");
      try { await expect(sql.query('SELECT * FROM "BillingEvent"')).rejects.toMatchObject({ code: "42501" }); }
      finally { await sql.query("SET row_security = on"); }
    });
  });
  it("keeps financial immutable snapshots enforced even for the allowed runtime", async () => {
    await asRole(backend, schemas[1], async () => {
      await expect(sql.query('UPDATE "BillingCheckout" SET "amountCents"="amountCents"+1')).rejects.toMatchObject({ code: "23514" });
    });
  });
  it("is a no-op when the configured backend role does not exist", async () => {
    await sql.query(`SET search_path TO "${schemas[0]}"`);
    await sql.query(fixtureMigration(`missing_backend_${suffix}`));
    expect((await sql.query(`SELECT * FROM pg_policies WHERE schemaname=$1`, [schemas[0]])).rowCount).toBe(0);
  });
  it("supports rollback by dropping only policies while preserving financial rows and RLS", async () => {
    await sql.query(`SET search_path TO "${schemas[0]}"`);
    const snapshots = new Map<string, unknown>();
    for (const table of tables) snapshots.set(table, (await sql.query(`SELECT row_to_json(t) AS row FROM "${table}" t ORDER BY row_to_json(t)::text`)).rows);
    const before = (snapshots.get("WorkspaceBilling") as unknown[]).length;
    await sql.query(fixtureMigration());
    try {
      await asRole(backend, schemas[0], async () => { expect((await sql.query(`SELECT * FROM "WorkspaceBilling"`)).rowCount).toBe(before); });
    } finally {
      for (const table of tables) await sql.query(`DROP POLICY "backend_billing_runtime" ON "${table}"`);
    }
    await asRole(backend, schemas[0], async () => { expect((await sql.query(`SELECT * FROM "WorkspaceBilling"`)).rowCount).toBe(0); });
    for (const table of tables) expect((await sql.query(`SELECT row_to_json(t) AS row FROM "${table}" t ORDER BY row_to_json(t)::text`)).rows).toEqual(snapshots.get(table));
  });
});
