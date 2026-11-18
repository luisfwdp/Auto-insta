/** Card-free trial contract on a disposable PostgreSQL schema. */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const schema = `billing_${randomBytes(4).toString("hex")}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient, context: null as unknown }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: async () => state.context, canManageBilling: (role: string) => role === "OWNER" }));
import { startCardFreeTrial, billingStatusDTO } from "../lib/billing/trial";
import { POST } from "../app/api/billing/trial/route";
import { GET } from "../app/api/billing/status/route";
let sql: Client;

describe.skipIf(!url)("card-free three-day trial", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const d of readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort()) await sql.query(readFileSync(path.join(root, d, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5, options: `-c search_path=${schema}` }, { schema }) });
    await state.db.user.create({ data: { id: "owner", email: "owner@example.test" } });
    for (const id of ["workspace-a", "workspace-b"]) await state.db.workspace.create({ data: { id, name: id, ownerId: "owner" } });
  });
  beforeEach(async () => {
    await state.db.workspaceBilling.deleteMany();
    await state.db.trialRedemption.deleteMany();
    state.context = { workspaceId: "workspace-a", role: "OWNER", userId: "owner" };
    vi.stubEnv("BILLING_ENABLED", "true");
  });
  afterAll(async () => { vi.unstubAllEnvs(); await state.db?.$disconnect(); if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });

  it("starts one72-hour trial without customer/card details or a provider call", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const before = Date.now(), dto = await startCardFreeTrial("workspace-a");
      expect(dto.hasAccess).toBe(true);
      expect(Date.parse(dto.trialEndsAt!) - Date.parse(dto.trialStartedAt!)).toBe(72 * 60 * 60 * 1000);
      expect(Date.parse(dto.trialStartedAt!)).toBeGreaterThanOrEqual(before);
      const row = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
      expect(row.providerCustomerId).toBeNull(); expect(row.providerSubscriptionId).toBeNull(); expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it("concurrent retries create exactly one trial with the same immutable deadline", async () => {
    const values = await Promise.all(Array.from({ length: 20 }, () => startCardFreeTrial("workspace-a")));
    expect(new Set(values.map(x => x.trialEndsAt)).size).toBe(1);
    expect(await state.db.workspaceBilling.count()).toBe(1);
  });
  it("does not rewrite the billing modification time on a trial retry", async () => {
    await startCardFreeTrial("workspace-a");
    const updatedAt = new Date("2000-01-01T00:00:00Z");
    await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { updatedAt } });
    await startCardFreeTrial("workspace-a");
    expect((await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } })).updatedAt).toEqual(updatedAt);
  });
  it("does not restart an expired or canceled trial", async () => {
    const started = new Date(Date.now() - 4 * 86400000), end = new Date(started.getTime() + 3 * 86400000);
    await state.db.workspaceBilling.create({ data: { workspaceId: "workspace-a", trialStartedAt: started, trialEndsAt: end } });
    expect(await startCardFreeTrial("workspace-a")).toMatchObject({ status: "EXPIRED", hasAccess: false, trialEndsAt: end.toISOString() });
    await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { status: "CANCELED" } });
    expect(await startCardFreeTrial("workspace-a")).toMatchObject({ status: "CANCELED", hasAccess: false, trialEndsAt: end.toISOString() });
  });
  it("shares the owner's immutable deadline across concurrent workspaces", async () => {
    const values = await Promise.all(Array.from({ length: 20 }, (_, i) => startCardFreeTrial(i % 2 ? "workspace-a" : "workspace-b")));
    expect(new Set(values.map(x => x.trialEndsAt)).size).toBe(1);
    expect(await state.db.trialRedemption.count()).toBe(1);
  });
  it("does not renew the trial by deleting and recreating a workspace", async () => {
    const started = new Date(Date.now() - 4 * 86400000), end = new Date(started.getTime() + 3 * 86400000);
    await state.db.trialRedemption.create({ data: { ownerId: "owner", trialStartedAt: started, trialEndsAt: end } });
    await startCardFreeTrial("workspace-a");
    await state.db.workspace.delete({ where: { id: "workspace-a" } });
    await state.db.workspace.create({ data: { id: "workspace-a", name: "replacement", ownerId: "owner" } });
    expect(await startCardFreeTrial("workspace-a")).toMatchObject({ status: "EXPIRED", hasAccess: false, trialEndsAt: end.toISOString() });
    expect(await startCardFreeTrial("workspace-b")).toMatchObject({ status: "EXPIRED", hasAccess: false });
  });
  it("keeps separate owners' trials independent", async () => {
    const started = new Date(Date.now() - 4 * 86400000), end = new Date(started.getTime() + 3 * 86400000);
    await state.db.trialRedemption.create({ data: { ownerId: "owner", trialStartedAt: started, trialEndsAt: end } });
    await state.db.user.create({ data: { id: "another-owner", email: "another@example.test" } });
    try {
      await state.db.workspace.create({ data: { id: "another-workspace", name: "another", ownerId: "another-owner" } });
      expect(await startCardFreeTrial("another-workspace")).toMatchObject({ status: "TRIALING", hasAccess: true });
      expect(await startCardFreeTrial("workspace-a")).toMatchObject({ status: "EXPIRED", hasAccess: false });
    } finally { await state.db.user.delete({ where: { id: "another-owner" } }); }
  });
  it("reports paid expiry and preserves paid access after cancellation, but not suspension", async () => {
    await startCardFreeTrial("workspace-a");
    const now = new Date();
    const row = await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { status: "ACTIVE", paidThrough: now } });
    expect(billingStatusDTO(row, now)).toMatchObject({ status: "EXPIRED", hasAccess: false });
    const paidThrough = new Date(now.getTime() + 86400000);
    expect(billingStatusDTO({ ...row, status: "CANCELED", paidThrough }, now)).toMatchObject({ status: "CANCELED", hasAccess: true });
    expect(billingStatusDTO({ ...row, status: "PAST_DUE", paidThrough }, now).hasAccess).toBe(true);
    expect(billingStatusDTO({ ...row, status: "SUSPENDED", paidThrough }, now).hasAccess).toBe(false);
  });
  it("uses the server workspace instead of a supplied tenant id", async () => {
    const request = new NextRequest("https://app.example.test/api/billing/trial", { method: "POST", headers: { Origin: "https://app.example.test", "x-cria-workspace-id": "workspace-a", "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: "workspace-b" }) });
    expect((await POST(request)).status).toBe(200);
    expect(await state.db.workspaceBilling.findUnique({ where: { workspaceId: "workspace-b" } })).toBeNull();
    expect(await state.db.workspaceBilling.count({ where: { workspaceId: "workspace-a" } })).toBe(1);
  });
  it.each(["ADMIN", "MEMBER"])("prevents%s from starting the owner's trial", async role => {
    state.context = { workspaceId: "workspace-a", role, userId: "owner" };
    expect((await POST(new NextRequest("https://app.example.test/api/billing/trial", { method: "POST", headers: { Origin: "https://app.example.test" } }))).status).toBe(403);
    expect(await state.db.workspaceBilling.count()).toBe(0);
  });
  it("rejects anonymous and cross-origin writes", async () => {
    const req = (origin: string) => new NextRequest("https://app.example.test/api/billing/trial", { method: "POST", headers: { Origin: origin } });
    expect((await POST(req("https://evil.example.test"))).status).toBe(403);
    state.context = null; expect((await POST(req("https://app.example.test"))).status).toBe(401);
  });
  it("requires an explicit browser Origin even with a chunked session cookie", async () => {
    expect((await POST(new NextRequest("https://app.example.test/api/billing/trial", { method: "POST", headers: { Cookie: "authjs.session-token.0=fake" } }))).status).toBe(403);
    expect(await state.db.workspaceBilling.count()).toBe(0);
  });
  it("leaves legacy self-hosted deployments untouched when disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");
    expect((await POST(new NextRequest("https://app.example.test/api/billing/trial", { method: "POST", headers: { Origin: "https://app.example.test" } }))).status).toBe(404);
    expect(await (await GET()).json()).toEqual({ success: true, data: { enabled: false } });
    expect(await state.db.workspaceBilling.count()).toBe(0);
  });
  it("does not expose provider identifiers and denies access at the exact expiry", async () => {
    await startCardFreeTrial("workspace-a");
    const row = await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { providerCustomerId: "cus_fake_private", providerSubscriptionId: "sub_fake_private" } });
    const dto = billingStatusDTO(row, row.trialEndsAt);
    expect(dto.hasAccess).toBe(false); expect(dto.status).toBe("EXPIRED");
    expect(JSON.stringify(dto)).not.toContain("fake_private");
    expect((await GET()).headers.get("Cache-Control")).toBe("no-store");
  });
  it("keeps trial data server-only even if a non-owner role receives table SELECT", async () => {
    await startCardFreeTrial("workspace-a");
    const role = `trial_anon_${randomBytes(4).toString("hex")}`;
    await sql.query(`CREATE ROLE "${role}" NOLOGIN`);
    try {
      await sql.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await sql.query(`GRANT SELECT ON "${schema}"."WorkspaceBilling" TO "${role}"`);
      await sql.query(`GRANT SELECT ON "${schema}"."TrialRedemption" TO "${role}"`);
      try {
        await sql.query(`SET ROLE "${role}"`);
        expect((await sql.query(`SELECT * FROM "${schema}"."WorkspaceBilling"`)).rowCount).toBe(0);
        expect((await sql.query(`SELECT * FROM "${schema}"."TrialRedemption"`)).rowCount).toBe(0);
      } finally { await sql.query("RESET ROLE"); }
    } finally {
      await sql.query(`REVOKE ALL ON "${schema}"."WorkspaceBilling" FROM "${role}"`);
      await sql.query(`REVOKE ALL ON "${schema}"."TrialRedemption" FROM "${role}"`);
      await sql.query(`REVOKE USAGE ON SCHEMA "${schema}" FROM "${role}"`);
      await sql.query(`DROP ROLE "${role}"`);
    }
    expect(await state.db.workspaceBilling.count()).toBe(1);
  });
  it("rejects rewriting either deadline at the database layer without blocking paid status updates", async () => {
    await startCardFreeTrial("workspace-a");
    for (const table of ["WorkspaceBilling", "TrialRedemption"]) {
      await expect(sql.query(`UPDATE "${schema}"."${table}" SET "trialStartedAt" = "trialStartedAt" + INTERVAL '1 day', "trialEndsAt" = "trialEndsAt" + INTERVAL '1 day'`)).rejects.toMatchObject({ code: "23514" });
    }
    await expect(state.db.workspaceBilling.update({ where: { workspaceId: "workspace-a" }, data: { status: "ACTIVE", paidThrough: new Date(Date.now() + 86400000) } })).resolves.toMatchObject({ status: "ACTIVE" });
  });
});
