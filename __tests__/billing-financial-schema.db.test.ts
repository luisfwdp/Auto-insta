/** Applies every migration to a private disposable PostgreSQL schema.
 * TEST_DATABASE_URL must never point to production. Uses a unique NOLOGIN test
 * role; never creates or modifies the shared anon/authenticated roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const schema = `financial_schema_${randomBytes(5).toString("hex")}`;
const scopeA = "10000000-0000-4000-8000-000000000001", scopeB = "10000000-0000-4000-8000-000000000002";
const tables = ["BillingCheckout", "BillingSubscription", "BillingPayment", "BillingEvent", "BillingCommand"];
let sql: Client, checkoutA: string, checkoutB: string, subA: string, subB: string;
type Row = Record<string, unknown>;

async function insert(table: string, row: Row, connection = sql) {
  const entries = Object.entries(row);
  await connection.query(`INSERT INTO "${table}" (${entries.map(([key]) => `"${key}"`).join(",")}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(",")})`, entries.map(([, value]) => value));
  return row.id as string;
}
async function update(table: string, id: string, row: Row) {
  const entries = Object.entries(row);
  return sql.query(`UPDATE "${table}" SET ${entries.map(([key], i) => `"${key}"=$${i + 1}`).join(",")} WHERE "id"=$${entries.length + 1}`,
    [...entries.map(([, value]) => value), id]);
}
const checkoutRow = (patch: Row = {}) => ({ id: randomUUID(), workspaceId: "workspace-a", environment: "sandbox", accountScope: scopeA, requestId: randomUUID(),
  planId: "pro-v1", amountCents: 14900, firstChargeDate: "2027-01-31", billingAnchorDay: 31, status: "COMPLETED", updatedAt: new Date(), ...patch });
const subRow = (checkoutId = checkoutA, patch: Row = {}) => ({ id: randomUUID(), workspaceId: "workspace-a", environment: "sandbox", accountScope: scopeA,
  providerSubscriptionId: `sub_${randomUUID()}`, providerCustomerId: "cus_fake_a", checkoutId, planId: "pro-v1", amountCents: 14900,
  billingAnchorDay: 31, renewalStatus: "ACTIVE", updatedAt: new Date(), ...patch });
const paymentRow = (patch: Row = {}) => ({ id: randomUUID(), workspaceId: "workspace-a", subscriptionId: subA, environment: "sandbox", accountScope: scopeA,
  providerPaymentId: `pay_${randomUUID()}`, amountCents: 14900, dueDate: "2027-01-31", status: "CONFIRMED", deleted: false, ...patch });
const eventRow = (patch: Row = {}) => ({ id: randomUUID(), environment: "sandbox", accountScope: scopeA, eventId: `evt_${randomUUID()}&123`,
  eventType: "PAYMENT_CONFIRMED", paymentId: "pay_fake", subscriptionId: "sub_fake", checkoutId: randomUUID(), updatedAt: new Date(), ...patch });
const commandRow = (patch: Row = {}) => ({ id: randomUUID(), workspaceId: "workspace-a", subscriptionId: subA, requestId: randomUUID(), updatedAt: new Date(), ...patch });

// All identifiers above and in mutation matrices below are static test fixtures.
describe.skipIf(!url)("financial database contracts", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort()) {
      await sql.query(readFileSync(path.join(root, dir, "migration.sql"), "utf8"));
    }
    await sql.query(`INSERT INTO "User" ("id","email","updatedAt") VALUES ('financial-owner','financial-owner@example.test',NOW())`);
    await sql.query(`INSERT INTO "Workspace" ("id","name","ownerId","updatedAt") VALUES ('workspace-a','A','financial-owner',NOW()),('workspace-b','B','financial-owner',NOW())`);
  });
  beforeEach(async () => {
    await sql.query(`TRUNCATE TABLE "BillingEvent","BillingCommand","BillingPayment","BillingSubscription","BillingCheckout","WorkspaceBilling" CASCADE`);
    await sql.query(`INSERT INTO "WorkspaceBilling" ("workspaceId","trialStartedAt","trialEndsAt","updatedAt") VALUES
      ('workspace-a','2027-01-01','2027-01-04',NOW()),('workspace-b','2027-01-01','2027-01-04',NOW())`);
    checkoutA = await insert("BillingCheckout", checkoutRow());
    checkoutB = await insert("BillingCheckout", checkoutRow({ workspaceId: "workspace-b", accountScope: scopeB }));
    subA = await insert("BillingSubscription", subRow());
    subB = await insert("BillingSubscription", subRow(checkoutB, { workspaceId: "workspace-b", accountScope: scopeB }));
  });
  afterAll(async () => { if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });

  it("accepts a complete tenant-consistent chain", async () => {
    await insert("BillingPayment", paymentRow()); await insert("BillingCommand", commandRow());
    await sql.query(`UPDATE "WorkspaceBilling" SET "currentSubscriptionId"=$1 WHERE "workspaceId"='workspace-a'`, [subA]);
    expect((await sql.query(`SELECT "currentSubscriptionId" FROM "WorkspaceBilling" WHERE "workspaceId"='workspace-a'`)).rows[0].currentSubscriptionId).toBe(subA);
  });
  it("restricts deleting a current subscription even when it has no payment or command children", async () => {
    await sql.query(`UPDATE "WorkspaceBilling" SET "currentSubscriptionId"=$1 WHERE "workspaceId"='workspace-a'`, [subA]);
    // PostgreSQL 16/18 report different integrity SQLSTATEs for this RESTRICT
    // deletion. The exact composite constraint and preserved rows are authority.
    await expect(sql.query(`DELETE FROM "BillingSubscription" WHERE id=$1`, [subA])).rejects.toMatchObject({ code: expect.stringMatching(/^(23001|23503)$/), constraint: "WorkspaceBilling_currentSubscriptionId_workspaceId_fkey" });
    expect((await sql.query(`SELECT id, "workspaceId" FROM "BillingSubscription" WHERE id=$1`, [subA])).rows).toEqual([{ id: subA, workspaceId: "workspace-a" }]);
    expect((await sql.query(`SELECT "currentSubscriptionId" FROM "WorkspaceBilling" WHERE "workspaceId"='workspace-a'`)).rows[0].currentSubscriptionId).toBe(subA);
  });
  it.each([{ workspaceId: "workspace-b" }, { environment: "production" }, { accountScope: scopeB }])("rejects subscription→checkout cross-tenant/provider linkage %#", async patch => {
    const checkout = await insert("BillingCheckout", checkoutRow());
    await expect(insert("BillingSubscription", subRow(checkout, patch))).rejects.toMatchObject({ code: "23503" });
  });
  it.each([{ workspaceId: "workspace-b" }, { environment: "production" }, { accountScope: scopeB }])("rejects payment→subscription cross-tenant/provider linkage %#", async patch => {
    await expect(insert("BillingPayment", paymentRow(patch))).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects command and current-subscription references into another workspace", async () => {
    await expect(insert("BillingCommand", commandRow({ workspaceId: "workspace-b" }))).rejects.toMatchObject({ code: "23503" });
    await expect(sql.query(`UPDATE "WorkspaceBilling" SET "currentSubscriptionId"=$1 WHERE "workspaceId"='workspace-a'`, [subB])).rejects.toMatchObject({ code: "23503" });
  });
  it.each(["CREATING", "OPEN", "UNKNOWN"])("prevents a second unresolved checkout beside %s, including status transitions", async status => {
    const open = await insert("BillingCheckout", checkoutRow({ status }));
    await expect(insert("BillingCheckout", checkoutRow({ status: "CREATING" }))).rejects.toMatchObject({ code: "23505", constraint: "BillingCheckout_one_unresolved_per_scope_key" });
    await expect(update("BillingCheckout", checkoutA, { status: "OPEN" })).rejects.toMatchObject({ code: "23505" });
    await update("BillingCheckout", open, { status: "EXPIRED" });
    await expect(insert("BillingCheckout", checkoutRow({ status: "CREATING" }))).resolves.toBeTypeOf("string");
  });
  it("isolates the unresolved-checkout uniqueness by workspace, environment and provider scope", async () => {
    await insert("BillingCheckout", checkoutRow({ status: "OPEN" }));
    await insert("BillingCheckout", checkoutRow({ status: "UNKNOWN", workspaceId: "workspace-b" }));
    await insert("BillingCheckout", checkoutRow({ status: "CREATING", environment: "production" }));
    await insert("BillingCheckout", checkoutRow({ status: "OPEN", accountScope: scopeB }));
    expect((await sql.query(`SELECT COUNT(*)::int AS count FROM "BillingCheckout" WHERE status IN ('CREATING','OPEN','UNKNOWN')`)).rows[0].count).toBe(4);
  });
  it("enforces one unresolved checkout during a genuine two-connection race", async () => {
    const other = new Client({ connectionString: url, options: `-c search_path=${schema}` }); await other.connect();
    try {
      const results = await Promise.allSettled([insert("BillingCheckout", checkoutRow({ status: "CREATING" })), insert("BillingCheckout", checkoutRow({ status: "CREATING" }), other)]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(r => r.status === "rejected")).toMatchObject([{ status: "rejected", reason: { code: "23505" } }]);
    } finally { await other.end(); }
  });
  it.each(["PENDING", "PROCESSING", "RETRY"])("prevents duplicate live cancellation beside %s while allowing a terminal audit row", async status => {
    const first = await insert("BillingCommand", commandRow({ status }));
    for (const candidate of ["PENDING", "PROCESSING", "RETRY"]) await expect(insert("BillingCommand", commandRow({ status: candidate }))).rejects.toMatchObject({ code: "23505", constraint: "BillingCommand_one_live_cancel_per_subscription_key" });
    await update("BillingCommand", first, { status: "PROCESSED" });
    await insert("BillingCommand", commandRow());
    await insert("BillingCommand", commandRow({ status: "DEAD" }));
    await insert("BillingCommand", commandRow({ workspaceId: "workspace-b", subscriptionId: subB }));
  });
  it.each([0, -1])("rejects nonpositive checkout/subscription/payment price%s", async amountCents => {
    await expect(insert("BillingCheckout", checkoutRow({ amountCents }))).rejects.toMatchObject({ code: "23514", constraint: "BillingCheckout_amount_positive" });
    const checkout = await insert("BillingCheckout", checkoutRow());
    await expect(insert("BillingSubscription", subRow(checkout, { amountCents }))).rejects.toMatchObject({ code: "23514", constraint: "BillingSubscription_amount_positive" });
    await expect(insert("BillingPayment", paymentRow({ amountCents }))).rejects.toMatchObject({ code: "23514", constraint: "BillingPayment_amount_positive" });
  });
  it.each([0, 32])("rejects checkout/subscription anchor%s", async billingAnchorDay => {
    await expect(insert("BillingCheckout", checkoutRow({ billingAnchorDay }))).rejects.toMatchObject({ code: "23514", constraint: "BillingCheckout_anchor_valid" });
    const checkout = await insert("BillingCheckout", checkoutRow());
    await expect(insert("BillingSubscription", subRow(checkout, { billingAnchorDay }))).rejects.toMatchObject({ code: "23514", constraint: "BillingSubscription_anchor_valid" });
  });
  it("rejects negative inbox/outbox attempts on insertion and workflow updates", async () => {
    await expect(insert("BillingEvent", eventRow({ attempts: -1 }))).rejects.toMatchObject({ code: "23514", constraint: "BillingEvent_attempts_nonnegative" });
    await expect(insert("BillingCommand", commandRow({ attempts: -1 }))).rejects.toMatchObject({ code: "23514", constraint: "BillingCommand_attempts_nonnegative" });
    const event = await insert("BillingEvent", eventRow()), command = await insert("BillingCommand", commandRow());
    await expect(update("BillingEvent", event, { attempts: -1 })).rejects.toMatchObject({ code: "23514", constraint: "BillingEvent_attempts_nonnegative" });
    await expect(update("BillingCommand", command, { attempts: -1 })).rejects.toMatchObject({ code: "23514", constraint: "BillingCommand_attempts_nonnegative" });
  });
  it.each([
    { id: randomUUID() }, { workspaceId: "workspace-b" }, { environment: "production" }, { accountScope: scopeB }, { requestId: randomUUID() },
    { planId: "starter-v2" }, { amountCents: 7900 }, { firstChargeDate: "2027-02-28" }, { billingAnchorDay: 28 }, { createdAt: new Date("2000-01-01") },
  ])("makes the checkout quote snapshot immutable %#", async patch => {
    await expect(update("BillingCheckout", checkoutA, patch)).rejects.toMatchObject({ code: "23514" });
  });
  it("binds the provider checkout exactly once, including protection from clearing it", async () => {
    const providerCheckoutId = randomUUID();
    await update("BillingCheckout", checkoutA, { providerCheckoutId, status: "OPEN", checkoutUrlCiphertext: "fake-encrypted-url", lastErrorCode: "TEST", updatedAt: new Date() });
    await expect(update("BillingCheckout", checkoutA, { providerCheckoutId })).resolves.toMatchObject({ rowCount: 1 });
    await expect(update("BillingCheckout", checkoutA, { providerCheckoutId: randomUUID() })).rejects.toMatchObject({ code: "23514" });
    await expect(update("BillingCheckout", checkoutA, { providerCheckoutId: null })).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    { id: randomUUID() }, { workspaceId: "workspace-b" }, { environment: "production" }, { accountScope: scopeB },
    { providerSubscriptionId: "sub_other" }, { providerCustomerId: "cus_other" }, { checkoutId: randomUUID() },
    { planId: "starter-v2" }, { amountCents: 7900 }, { billingAnchorDay: 28 }, { createdAt: new Date("2000-01-01") },
  ])("makes the subscription/provider/quote binding immutable %#", async patch => {
    await expect(update("BillingSubscription", subA, patch)).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    { id: randomUUID() }, { workspaceId: "workspace-b" }, { subscriptionId: randomUUID() }, { environment: "production" }, { accountScope: scopeB },
    { providerPaymentId: "pay_other" }, { amountCents: 7900 }, { dueDate: "2027-02-28" },
  ])("makes payment identity/value/due-date immutable %#", async patch => {
    const payment = await insert("BillingPayment", paymentRow());
    await expect(update("BillingPayment", payment, patch)).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    { id: randomUUID() }, { environment: "production" }, { accountScope: scopeB }, { eventId: "evt_other&123" }, { eventType: "PAYMENT_OVERDUE" },
    { paymentId: "pay_other" }, { subscriptionId: "sub_other" }, { checkoutId: randomUUID() }, { createdAt: new Date("2000-01-01") },
  ])("makes inbox event and resource linkage immutable %#", async patch => {
    const event = await insert("BillingEvent", eventRow());
    await expect(update("BillingEvent", event, patch)).rejects.toMatchObject({ code: "23514" });
  });
  it.each([{ id: randomUUID() }, { workspaceId: "workspace-b" }, { subscriptionId: randomUUID() }, { requestId: randomUUID() }, { createdAt: new Date("2000-01-01") }])("makes command request and tenant/subscription binding immutable %#", async patch => {
    const command = await insert("BillingCommand", commandRow());
    await expect(update("BillingCommand", command, patch)).rejects.toMatchObject({ code: "23514" });
  });
  it("allows canonical status/deleted/sync and inbox/outbox lease progression", async () => {
    const payment = await insert("BillingPayment", paymentRow()), event = await insert("BillingEvent", eventRow()), command = await insert("BillingCommand", commandRow());
    await update("BillingSubscription", subA, { renewalStatus: "CANCELED", updatedAt: new Date() });
    await update("BillingPayment", payment, { status: "REFUNDED", deleted: true, syncedAt: new Date() });
    for (const [table, id] of [["BillingEvent", event], ["BillingCommand", command]]) {
      await expect(update(table, id, { status: "PROCESSING", attempts: 1, leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000),
        nextAttemptAt: new Date(), lastErrorCode: "RECONCILE", updatedAt: new Date() })).resolves.toMatchObject({ rowCount: 1 });
    }
  });
  it("enables RLS and revokes browser/public grants on every financial table", async () => {
    for (const table of tables) {
      const { rows } = await sql.query(`SELECT c.relrowsecurity AS rls, EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) AS acl WHERE acl.grantee=0) AS public_grant
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`, [schema, table]);
      expect(rows).toEqual([{ rls: true, public_grant: false }]);
      for (const role of ["anon", "authenticated"]) {
        const exists = (await sql.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [role])).rowCount;
        if (exists) expect((await sql.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`, [role, `"${schema}"."${table}"`])).rows[0].allowed).toBe(false);
      }
    }
  });
  it("denies direct financial reads/writes even after a non-owner receives table grants", async () => {
    await insert("BillingPayment", paymentRow()); await insert("BillingEvent", eventRow()); await insert("BillingCommand", commandRow());
    const role = `financial_anon_${randomBytes(5).toString("hex")}`;
    const tableList = tables.map(table => `"${schema}"."${table}"`).join(",");
    await sql.query(`CREATE ROLE "${role}" NOLOGIN`);
    try {
      await sql.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await sql.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${tableList} TO "${role}"`);
      try {
        await sql.query(`SET ROLE "${role}"`);
        for (const table of tables) {
          expect((await sql.query(`SELECT * FROM "${table}"`)).rowCount).toBe(0);
          expect((await sql.query(`DELETE FROM "${table}"`)).rowCount).toBe(0);
        }
        await expect(insert("BillingEvent", eventRow())).rejects.toMatchObject({ code: "42501" });
      } finally { await sql.query("RESET ROLE"); }
    } finally {
      await sql.query(`REVOKE ALL ON ${tableList} FROM "${role}"`);
      await sql.query(`REVOKE USAGE ON SCHEMA "${schema}" FROM "${role}"`);
      await sql.query(`DROP ROLE "${role}"`);
    }
    expect((await sql.query(`SELECT COUNT(*)::int AS count FROM "BillingPayment"`)).rows[0].count).toBe(1);
  });
});
