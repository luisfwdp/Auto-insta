/** Disposable PostgreSQL only. Administrative grants use the schema owner;
 * application calls run as a private NOLOGIN, NOBYPASSRLS runtime role. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const url = process.env.TEST_DATABASE_URL, suffix = randomBytes(6).toString("hex");
const schema = `lifetime_${suffix}`, backend = `lifetime_backend_${suffix}`, untrusted = `lifetime_browser_${suffix}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { assertCommercialAccess, readLifetimeBillingStatus } from "../lib/billing/commercial-access";
import { withCommercialAccountCapacity } from "../lib/billing/commercial-capacity";
import { reserveCommercialUsage, beginCommercialDispatch, finishCommercialDispatch } from "../lib/billing/commercial-usage";
import { requestCheckout } from "../lib/billing/checkout";
import { createAsaasClient } from "../lib/billing/asaas-client";
import { reserveCommercialStorageAsset } from "../lib/billing/commercial-storage";
let sql: Client, admin: PrismaClient, grantId: string;
const createdRoles: string[] = [];

async function asRole<T>(role: string, run: () => Promise<T>) {
  await sql.query(`SET ROLE "${role}"`);
  try { return await run(); } finally { await sql.query("RESET ROLE"); }
}
describe.skipIf(!url)("administrative lifetime license and runtime RLS", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect();
    for (const role of [backend, untrusted]) {
      await sql.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`); createdRoles.push(role);
    }
    await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma/migrations");
    for (const name of readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort()) {
      if (name === "20261123233000_workspace_lifetime_access") {
        await sql.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${backend}", "${untrusted}"`);
        await sql.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${backend}"`);
      }
      let source = readFileSync(path.join(root, name, "migration.sql"), "utf8");
      if (["20261118140000_backend_billing_rls", "20261123233000_workspace_lifetime_access"].includes(name)) {
        source = source.replaceAll("pingchat_runtime", backend);
        for (const role of ["anon", "authenticated", "service_role"]) source = source.replaceAll(`'${role}'`, `'missing_${role}_${suffix}'`);
      }
      await sql.query(source);
    }
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: `-c search_path=${schema}` }, { schema }) });
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10, options: `-c search_path=${schema} -c role=${backend}` }, { schema }), transactionOptions: { maxWait: 10000 } });
    await admin.user.createMany({ data: [{ id: "owner-a", email: "a@example.test" }, { id: "owner-b", email: "b@example.test" }] });
    await admin.workspace.createMany({ data: [{ id: "workspace-a", name: "A", ownerId: "owner-a" }, { id: "workspace-b", name: "B", ownerId: "owner-a" }, { id: "workspace-c", name: "C", ownerId: "owner-b" }] });
  });
  beforeEach(async () => {
    vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("BILLING_SALES_ENABLED", "true"); vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("FLY_APP_NAME", "");
    vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", "12000000-0000-4000-8000-000000000001"); vi.stubEnv("ASAAS_API_KEY", "fixture-key-".repeat(4)); vi.stubEnv("ENCRYPTION_KEY", "11".repeat(32)); vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    await admin.publishingAsset.deleteMany(); await admin.instagramAccount.deleteMany();
    await sql.query('TRUNCATE "WorkspaceBilling", "TrialRedemption", "CommercialUsageBucket" CASCADE');
    await admin.workspace.update({ where: { id: "workspace-a" }, data: { ownerId: "owner-a" } });
    const trialStartedAt = new Date(Date.now() - 8 * 86400000), trialEndsAt = new Date(trialStartedAt.getTime() + 72 * 3600000);
    await admin.trialRedemption.createMany({ data: ["owner-a", "owner-b"].map(ownerId => ({ ownerId, trialStartedAt, trialEndsAt })) });
    await admin.workspaceBilling.createMany({ data: ["workspace-a", "workspace-b", "workspace-c"].map(workspaceId => ({ workspaceId, trialStartedAt, trialEndsAt })) });
    grantId = randomUUID();
    await admin.workspaceLifetimeAccess.create({ data: { id: grantId, workspaceId: "workspace-a", ownerId: "owner-a", planId: "agency-v1", grantedBy: "fixture-operator", reason: "Explicit license authorization", approvalReference: "fixture-review" } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    await state.db?.$disconnect(); await admin?.$disconnect();
    if (sql) {
      await sql.query("RESET ROLE"); await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      for (const role of createdRoles) await sql.query(`DROP ROLE "${role}"`);
      await sql.end();
    }
  });
  it("allows only the bound workspace without renewing trial or inventing financial records", async () => {
    const before = await admin.workspaceBilling.findMany({ orderBy: { workspaceId: "asc" } });
    await expect(assertCommercialAccess("workspace-a")).resolves.toBeUndefined();
    for (const workspace of ["workspace-b", "workspace-c"]) await expect(assertCommercialAccess(workspace)).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_REQUIRED" });
    expect(await readLifetimeBillingStatus("workspace-a")).toEqual({ status: "LIFETIME", hasAccess: true, planId: "agency-v1" });
    expect(await readLifetimeBillingStatus("workspace-b")).toBeNull();
    expect(await admin.workspaceBilling.findMany({ orderBy: { workspaceId: "asc" } })).toEqual(before);
    expect(await admin.billingPayment.count()).toBe(0); expect(await admin.billingSubscription.count()).toBe(0);
    expect(await admin.trialRedemption.count()).toBe(2);
  });
  it("allows runtime reads but forbids grants, edits, revocation, deletion, truncate and DDL", async () => {
    expect(await state.db.workspaceLifetimeAccess.count()).toBe(1);
    await asRole(backend, async () => {
      for (const statement of [
        'INSERT INTO "WorkspaceLifetimeAccess" SELECT * FROM "WorkspaceLifetimeAccess"',
        'UPDATE "WorkspaceLifetimeAccess" SET "planId"=\'essential-v1\'',
        'DELETE FROM "WorkspaceLifetimeAccess"', 'TRUNCATE "WorkspaceLifetimeAccess"',
        'ALTER TABLE "WorkspaceLifetimeAccess" DISABLE ROW LEVEL SECURITY',
      ]) await expect(sql.query(statement)).rejects.toMatchObject({ code: "42501" });
    });
    // Even accidental browser ACLs cannot bypass the absence of an RLS policy.
    await sql.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON "WorkspaceLifetimeAccess" TO "${untrusted}"`);
    try {
      await asRole(untrusted, async () => {
        expect((await sql.query('SELECT * FROM "WorkspaceLifetimeAccess"')).rowCount).toBe(0);
        expect((await sql.query('DELETE FROM "WorkspaceLifetimeAccess"')).rowCount).toBe(0);
        await expect(sql.query('INSERT INTO "WorkspaceLifetimeAccess" ("workspaceId","id","ownerId","planId","grantedBy","reason","approvalReference") VALUES (\'workspace-b\',$1,\'owner-a\',\'agency-v1\',\'browser\',\'forbidden\',\'none\')', [randomUUID()])).rejects.toMatchObject({ code: "42501" });
      });
    } finally { await sql.query(`REVOKE ALL ON "WorkspaceLifetimeAccess" FROM "${untrusted}"`); }
  });
  it("retains account quotas and reconnects existing accounts at the cap", async () => {
    for (let i = 0; i < 10; i++) await withCommercialAccountCapacity("workspace-a", `ig_${i}`, tx => tx.instagramAccount.create({ data: { workspaceId: "workspace-a", instagramId: `ig_${i}`, username: `fixture_${i}`, accessToken: "fixture" } }));
    await expect(withCommercialAccountCapacity("workspace-a", "ig_extra", async () => null)).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_LIMIT" });
    await expect(withCommercialAccountCapacity("workspace-a", "ig_0", async () => "reconnected")).resolves.toBe("reconnected");
    await expect(withCommercialAccountCapacity("workspace-b", "ig_0", async () => null)).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_DENIED" });
  });
  it("meters lifetime dispatches idempotently and enforces monthly quotas without Asaas", async () => {
    vi.stubEnv("ASAAS_ENVIRONMENT", "unconfigured");
    const rows = await Promise.all(Array.from({ length: 10 }, () => reserveCommercialUsage("workspace-a", "DM", "same-intent", 30000)));
    expect(new Set(rows.map(row => row.reservationId)).size).toBe(1);
    await expect(reserveCommercialUsage("workspace-a", "DM", "above-limit")).rejects.toMatchObject({ code: "COMMERCIAL_QUOTA_EXCEEDED" });
    const id = rows[0].reservationId!, claim = await beginCommercialDispatch("workspace-a", id);
    expect(claim).not.toBeNull();
    expect(await finishCommercialDispatch("workspace-a", id, claim!.dispatchToken, "CONFIRMED", { messageId: "fixture-confirmed-receipt" })).toBe(true);
    expect(await beginCommercialDispatch("workspace-a", id)).toBeNull();
    expect(await admin.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ subjectKind: "WORKSPACE_GRANT", subjectId: grantId, scopeKey: "workspace-lifetime-v1", consumed: BigInt(30000), reserved: BigInt(0) });
    expect(await admin.commercialUsageReservation.count()).toBe(1);
  });
  it("does not charge licensed account connections against another workspace's still-valid owner trial", async () => {
    // Recreate disposable fixtures; production trial deadlines are immutable.
    await admin.workspaceLifetimeAccess.deleteMany();
    await admin.workspaceBilling.deleteMany({ where: { workspaceId: { in: ["workspace-a", "workspace-b"] } } });
    await admin.trialRedemption.delete({ where: { ownerId: "owner-a" } });
    const trialStartedAt = new Date(Date.now() - 60000), trialEndsAt = new Date(trialStartedAt.getTime() + 72 * 3600000);
    await admin.trialRedemption.create({ data: { ownerId: "owner-a", trialStartedAt, trialEndsAt } });
    await admin.workspaceBilling.createMany({ data: ["workspace-a", "workspace-b"].map(workspaceId => ({ workspaceId, trialStartedAt, trialEndsAt })) });
    await admin.workspaceLifetimeAccess.create({ data: { id: grantId, workspaceId: "workspace-a", ownerId: "owner-a", planId: "agency-v1", grantedBy: "fixture", reason: "fixture", approvalReference: "fixture" } });
    await admin.instagramAccount.create({ data: { workspaceId: "workspace-a", instagramId: "licensed-account", username: "licensed_fixture", accessToken: "fixture" } });
    await expect(withCommercialAccountCapacity("workspace-b", "trial-account", tx => tx.instagramAccount.create({ data: { workspaceId: "workspace-b", instagramId: "trial-account", username: "trial_fixture", accessToken: "fixture" } }))).resolves.toMatchObject({ workspaceId: "workspace-b" });
    await expect(withCommercialAccountCapacity("workspace-b", "extra-trial", async () => null)).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_LIMIT" });
  });
  it("rejects borrowing a licensed bucket from another workspace even for the same owner", async () => {
    await reserveCommercialUsage("workspace-a", "DM", "legitimate-binding");
    const bucket = await admin.commercialUsageBucket.findFirstOrThrow();
    await asRole(backend, async () => {
      await expect(sql.query('INSERT INTO "CommercialUsageReservation" (id,"workspaceId","bucketId",resource,"operationKey",amount,"updatedAt") VALUES ($1,\'workspace-b\',$2,\'DM\',\'foreign-binding\',1,now())', [randomUUID(), bucket.id])).rejects.toMatchObject({ code: "23514" });
    });
    expect(await admin.commercialUsageReservation.count()).toBe(1);
  });
  it("honors administrative revocation, suspension and owner changes before new side effects", async () => {
    const hold = await reserveCommercialUsage("workspace-a", "PUBLICATION", "before-revoke");
    await admin.workspaceLifetimeAccess.update({ where: { workspaceId: "workspace-a" }, data: { revokedAt: new Date(), revokedBy: "fixture-operator", revocationReason: "Authorized rollback" } });
    await expect(beginCommercialDispatch("workspace-a", hold.reservationId!)).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_REQUIRED" });
    await expect(reserveCommercialUsage("workspace-a", "PUBLICATION", "after-revoke")).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_REQUIRED" });
    expect(await admin.commercialUsageReservation.count()).toBe(1);
    // Use a fresh grant only in this disposable owner-level fixture.
    await admin.workspaceLifetimeAccess.deleteMany();
    await admin.workspaceLifetimeAccess.create({ data: { id: randomUUID(), workspaceId: "workspace-a", ownerId: "owner-a", planId: "agency-v1", grantedBy: "fixture", reason: "fixture", approvalReference: "fixture" } });
    await admin.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { status: "SUSPENDED" } });
    await expect(assertCommercialAccess("workspace-a")).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_REQUIRED" });
    await admin.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { status: "TRIALING" } });
    await admin.workspace.update({ where: { id: "workspace-a" }, data: { ownerId: "owner-b" } });
    await expect(assertCommercialAccess("workspace-a")).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_REQUIRED" });
  });
  it("rejects checkout before recording an intent or invoking the provider", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(requestCheckout("workspace-a", { requestId: randomUUID(), planId: "essential-v1", expectedAmountCents: 7900, acceptImmediateCharge: true }, createAsaasClient())).rejects.toMatchObject({ code: "LIFETIME_ACCESS_ACTIVE", httpStatus: 409 });
    expect(fetcher).not.toHaveBeenCalled(); expect(await admin.billingCheckout.count()).toBe(0);
  });
  it("enforces retained storage for this workspace instead of sharing its license with another workspace", async () => {
    await admin.publishingAsset.create({ data: { id: randomUUID(), workspaceId: "workspace-b", filename: "retained.jpg", storagePath: "fixture/retained.jpg", mimeType: "image/jpeg", mediaType: "IMAGE", byteSize: 1, uploadCapacityBytes: BigInt(30000000000) } });
    const input = { filename: "fixture.jpg", mimeType: "image/jpeg" as const, byteSize: 1 };
    await expect(reserveCommercialStorageAsset("workspace-a", input, 30000000000)).resolves.toMatchObject({ workspaceId: "workspace-a" });
    await expect(reserveCommercialStorageAsset("workspace-a", input, 1)).rejects.toMatchObject({ code: "COMMERCIAL_STORAGE_LIMIT" });
    await expect(reserveCommercialStorageAsset("workspace-b", input, 1)).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_DENIED" });
  });
  it("requires complete grant and revocation audit evidence at the database boundary", async () => {
    for (const data of [{ revokedAt: new Date() }, { revokedAt: new Date(), revokedBy: "operator" }, { reason: " " }, { planId: "unknown" }]) {
      await expect(admin.workspaceLifetimeAccess.update({ where: { workspaceId: "workspace-a" }, data })).rejects.toThrow();
    }
    expect((await admin.workspaceLifetimeAccess.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).revokedAt).toBeNull();
  });
});
