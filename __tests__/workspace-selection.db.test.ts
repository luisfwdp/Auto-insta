/** Workspace selection with real PostgreSQL membership/auth resolution. Only
 * the signed-in identity is faked; no client, provider or production data. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const url = process.env.TEST_DATABASE_URL, schema = `workspace_selection_${randomBytes(5).toString("hex")}`;
const scope = "1eb34a1e-82b8-4a6f-a67a-202654136d47";
const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  authCalls: 0,
}));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("next-auth", () => ({ default: () => ({ handlers: {}, auth: async () => {
  state.authCalls += 1; return { user: { id: "alice", email: "alice@example.test" } };
}, signIn: async () => {}, signOut: async () => {} }) }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));

import { GET, POST } from "@/app/api/workspace/selection/route";
import { POST as acceptInvitation } from "@/app/api/workspace/invitations/accept/route";
import { GET as members } from "@/app/api/workspace/members/route";
import { getSelectedWorkspaceMembership } from "@/lib/workspace-selection";
import { getCurrentWorkspaceContext, canManageWorkspace, canManageBilling } from "@/lib/workspace-access";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";
import { BILLING_PLANS } from "@/lib/billing/catalog";
import { monthlyInvoicePeriod } from "@/lib/billing/financial-policy";
import { saoPauloDate } from "@/lib/billing/config";

let sql: Client;
function request(workspaceId: string) {
  return new NextRequest("http://localhost/api/workspace/selection", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId }) });
}
async function invitation() {
  await state.db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: "workspace-b", userId: "alice" } } });
  await state.db.workspaceInvitation.create({ data: { workspaceId: "workspace-b", email: "alice@example.test", role: "ADMIN", token: "fixture-invitation", expiresAt: new Date(Date.now() + 86400000) } });
}
async function makeAgencyPaid() {
  const date = saoPauloDate(new Date()), anchor = Number(date.slice(-2)), period = monthlyInvoicePeriod(date, anchor), plan = BILLING_PLANS["agency-v1"];
  const checkout = await state.db.billingCheckout.create({ data: { workspaceId: "workspace-b", environment: "sandbox", accountScope: scope,
    requestId: randomUUID(), planId: "agency-v1", amountCents: plan.amountCents, firstChargeDate: date, billingAnchorDay: anchor, status: "COMPLETED", providerCheckoutId: randomUUID() } });
  const subscription = await state.db.billingSubscription.create({ data: { workspaceId: "workspace-b", environment: "sandbox", accountScope: scope,
    providerSubscriptionId: "sub_fixture_agency", providerCustomerId: "cus_fixture_agency", checkoutId: checkout.id,
    planId: "agency-v1", amountCents: plan.amountCents, billingAnchorDay: anchor, renewalStatus: "ACTIVE" } });
  await state.db.billingPayment.create({ data: { workspaceId: "workspace-b", subscriptionId: subscription.id, environment: "sandbox", accountScope: scope,
    providerPaymentId: "pay_fixture_agency", amountCents: plan.amountCents, dueDate: date, status: "CONFIRMED", deleted: false } });
  await state.db.workspaceBilling.update({ where: { workspaceId: "workspace-b" }, data: { status: "ACTIVE", currentSubscriptionId: subscription.id, planId: "agency-v1", paidThrough: period.endsAt } });
}

describe.skipIf(!url)("workspace selection on isolated PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const migrations = path.join(__dirname, "..", "prisma", "migrations");
    for (const directory of readdirSync(migrations, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort())
      await sql.query(readFileSync(path.join(migrations, directory, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: `-c search_path=${schema}` }, { schema }) });
  });
  beforeEach(async () => {
    vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scope);
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("FLY_APP_NAME", ""); vi.stubEnv("NEXTAUTH_URL", "http://localhost");
    await sql.query(`TRUNCATE TABLE "User", "Workspace" CASCADE`);
    await state.db.user.createMany({ data: [{ id: "alice", email: "alice@example.test" }, { id: "bob", email: "bob@example.test" }] });
    await state.db.workspace.createMany({ data: [{ id: "workspace-a", name: "A", ownerId: "alice" }, { id: "workspace-b", name: "B", ownerId: "bob" }] });
    await state.db.workspaceMember.createMany({ data: [
      { workspaceId: "workspace-a", userId: "alice", role: "OWNER", createdAt: new Date(Date.now() - 86400000) },
      { workspaceId: "workspace-b", userId: "bob", role: "OWNER", createdAt: new Date(Date.now() - 86400000) },
      { workspaceId: "workspace-b", userId: "alice", role: "MEMBER" },
    ] });
    // Expired trial fixtures: membership selection must not depend on payment.
    const trialStartedAt = new Date(Date.now() - 7 * 86400000), trialEndsAt = new Date(trialStartedAt.getTime() + 72 * 3600000);
    await state.db.workspaceBilling.createMany({ data: ["workspace-a", "workspace-b"].map(workspaceId => ({ workspaceId, trialStartedAt, trialEndsAt })) });
    state.authCalls = 0;
  });
  afterAll(async () => {
    vi.unstubAllEnvs(); await state.db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });

  it("selects A then B durably while preserving both memberships and each role", async () => {
    expect((await getSelectedWorkspaceMembership("alice"))?.workspaceId).toBe("workspace-a");
    expect((await POST(request("workspace-b"))).status).toBe(200);
    expect(await state.db.user.findUniqueOrThrow({ where: { id: "alice" } })).toMatchObject({ activeWorkspaceId: "workspace-b" });
    expect((await getCurrentWorkspaceContext())?.workspaceId).toBe("workspace-b");
    expect(await getCurrentWorkspaceId()).toBe("workspace-b");
    expect((await ensureWorkspaceForUser("alice", "alice@example.test")).id).toBe("workspace-b");
    expect((await getPrimaryWorkspace("alice"))?.id).toBe("workspace-b");
    expect(await state.db.workspaceMember.count({ where: { userId: "alice" } })).toBe(2);
    expect((await state.db.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: "workspace-a", userId: "alice" } } })).role).toBe("OWNER");
    expect((await POST(request("workspace-a"))).status).toBe(200);
    expect((await getCurrentWorkspaceContext())?.workspaceId).toBe("workspace-a");
  });

  it("keeps MEMBER authority after selecting an expired agency workspace", async () => {
    const response = await POST(request("workspace-b")); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { id: "workspace-b", name: "B", role: "MEMBER" } });
    const context = await getCurrentWorkspaceContext(); expect(context?.role).toBe("MEMBER");
    expect(canManageWorkspace(context!.role)).toBe(false); expect(canManageBilling(context!.role)).toBe(false);
    const api = await members(), payload = await api.json();
    expect(payload.data.currentUserRole).toBe("MEMBER"); expect(payload.data.invitations).toEqual([]);
    expect(payload.data.members.map((x: { user: { id: string } }) => x.user.id).sort()).toEqual(["alice", "bob"]);
    expect((await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-b" } })).trialEndsAt.getTime()).toBeLessThan(Date.now());
  });

  it("falls back to A after B membership is revoked without recreating B access", async () => {
    await POST(request("workspace-b"));
    await state.db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: "workspace-b", userId: "alice" } } });
    expect((await getCurrentWorkspaceContext())).toMatchObject({ workspaceId: "workspace-a", role: "OWNER" });
    expect(await getCurrentWorkspaceId()).toBe("workspace-a");
    const response = await GET(), payload = await response.json();
    expect(payload.data).toEqual({ activeWorkspaceId: "workspace-a", activeWorkspaceName: "A", workspaces: [{ id: "workspace-a", name: "A", role: "OWNER" }] });
    expect(await state.db.workspaceMember.count({ where: { userId: "alice" } })).toBe(1);
  });

  it("does not select a foreign workspace or change either user's preference", async () => {
    await state.db.user.update({ where: { id: "alice" }, data: { activeWorkspaceId: "workspace-a" } });
    await state.db.user.update({ where: { id: "bob" }, data: { activeWorkspaceId: "workspace-b" } });
    await state.db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: "workspace-b", userId: "alice" } } });
    const response = await POST(request("workspace-b")); expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: "NOT_FOUND" });
    expect((await state.db.user.findUniqueOrThrow({ where: { id: "alice" } })).activeWorkspaceId).toBe("workspace-a");
    expect((await state.db.user.findUniqueOrThrow({ where: { id: "bob" } })).activeWorkspaceId).toBe("workspace-b");
    // Even an internally corrupted preference can never grant membership.
    await state.db.user.update({ where: { id: "alice" }, data: { activeWorkspaceId: "workspace-b" } });
    expect((await getSelectedWorkspaceMembership("alice"))?.workspaceId).toBe("workspace-a");
  });

  it("selects B atomically after explicit invitation acceptance and keeps the owner membership in A", async () => {
    await makeAgencyPaid(); await invitation();
    const response = await acceptInvitation(new NextRequest("http://localhost/api/workspace/invitations/accept", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "fixture-invitation" }) }));
    expect(response.status).toBe(200);
    expect((await getCurrentWorkspaceContext())).toMatchObject({ workspaceId: "workspace-b", role: "ADMIN" });
    expect(await getCurrentWorkspaceId()).toBe("workspace-b");
    expect((await ensureWorkspaceForUser("alice", "alice@example.test")).id).toBe("workspace-b");
    expect((await getPrimaryWorkspace("alice"))?.id).toBe("workspace-b");
    expect(await state.db.workspaceMember.count({ where: { userId: "alice" } })).toBe(2);
    expect((await state.db.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: "workspace-a", userId: "alice" } } })).role).toBe("OWNER");
  });

  it("does not change the chosen workspace when accepting invitations automatically", async () => {
    await makeAgencyPaid(); await invitation();
    await state.db.user.update({ where: { id: "alice" }, data: { activeWorkspaceId: "workspace-a" } });
    expect((await ensureWorkspaceForUser("alice", "alice@example.test")).id).toBe("workspace-a");
    expect((await state.db.workspaceInvitation.findUniqueOrThrow({ where: { token: "fixture-invitation" } })).status).toBe("ACCEPTED");
    expect(await state.db.workspaceMember.count({ where: { userId: "alice" } })).toBe(2);
    expect((await state.db.user.findUniqueOrThrow({ where: { id: "alice" } })).activeWorkspaceId).toBe("workspace-a");
  });

  it("preserves the first workspace in OFF mode with no new user query, auth or preference mutation", async () => {
    await state.db.user.update({ where: { id: "alice" }, data: { activeWorkspaceId: "workspace-b" } });
    vi.stubEnv("BILLING_ENABLED", "false");
    const userRead = vi.spyOn(state.db.user, "findUnique"), update = vi.spyOn(state.db.user, "update");
    try {
      expect((await getSelectedWorkspaceMembership("alice"))?.workspaceId).toBe("workspace-a");
      expect(userRead).not.toHaveBeenCalled();
      expect((await GET()).status).toBe(404); expect((await POST(request("workspace-a"))).status).toBe(404);
      expect(state.authCalls).toBe(0); expect(update).not.toHaveBeenCalled();
    } finally { userRead.mockRestore(); update.mockRestore(); }
  });

  it("clears preferences through the FK when a selected workspace is removed", async () => {
    await POST(request("workspace-b")); await state.db.workspace.delete({ where: { id: "workspace-b" } });
    expect((await state.db.user.findUniqueOrThrow({ where: { id: "alice" } })).activeWorkspaceId).toBeNull();
    expect((await getSelectedWorkspaceMembership("alice"))?.workspaceId).toBe("workspace-a");
  });
});
