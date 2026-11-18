/** Native capacity transactions and route hooks. All identities are fixtures;
 * no Meta/Zernio/network request is made by these tests. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL, schema = `capacity_${randomBytes(5).toString("hex")}`;
const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient, context: { workspaceId: "workspace-a", userId: "owner-a", role: "OWNER" }, session: null as { user: { id: string; email: string } } | null }));
const remote = vi.hoisted(() => ({ exchange: vi.fn(), longLived: vi.fn(), userInfo: vi.fn(), assigned: vi.fn(), subscribe: vi.fn(), facebookToken: vi.fn(), pages: vi.fn(), permissions: vi.fn(), subscribePage: vi.fn(), zernioAccounts: vi.fn(), nonces: new Map<string, string>() }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: async () => state.context, canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN" }));
vi.mock("@/lib/auth", () => ({ auth: async () => state.session }));
vi.mock("@/lib/meta/oauth", async original => ({ ...await original<typeof import("../lib/meta/oauth")>(), exchangeCodeForToken: (...args: unknown[]) => remote.exchange(...args) }));
vi.mock("@/lib/meta/client", async original => ({ ...await original<typeof import("../lib/meta/client")>(), getLongLivedToken: (...args: unknown[]) => remote.longLived(...args), getUserInfo: (...args: unknown[]) => remote.userInfo(...args), resolveAssignedInstagramAccounts: (...args: unknown[]) => remote.assigned(...args), subscribeInstagramAccountToWebhooks: (...args: unknown[]) => remote.subscribe(...args) }));
vi.mock("@/lib/meta/facebook-login", async original => ({ ...await original<typeof import("../lib/meta/facebook-login")>(), exchangeForLongLivedUserToken: (...args: unknown[]) => remote.facebookToken(...args), resolvePageInstagramAccounts: (...args: unknown[]) => remote.pages(...args), getGrantedPermissions: (...args: unknown[]) => remote.permissions(...args), subscribePageToWebhooks: (...args: unknown[]) => remote.subscribePage(...args) }));
vi.mock("@/lib/meta/oauth-nonce", () => ({ consumeOAuthNonce: async (nonce: string, userId: string, workspaceId: string) => { const value = remote.nonces.get(nonce); remote.nonces.delete(nonce); return value === `${userId}|${workspaceId}`; } }));
vi.mock("@/lib/zernio/manage-remote", () => ({ listInstagramAccounts: (...args: unknown[]) => remote.zernioAccounts(...args) }));
import { assertCommercialAccountUsable, assertCommercialCapacityAccess, assertCommercialMemberCapacity, withCommercialAccountCapacity } from "../lib/billing/commercial-capacity";
import { startCardFreeTrial } from "../lib/billing/trial";
import { monthlyInvoicePeriod } from "../lib/billing/financial-policy";
import { BILLING_PLANS, type BillingPlanId } from "../lib/billing/catalog";
import { POST as invitePOST, DELETE as memberDELETE, GET as memberGET } from "../app/api/workspace/members/route";
import { POST as acceptPOST } from "../app/api/workspace/invitations/accept/route";
import { acceptPendingInvitationsForUser } from "../lib/workspace";
import { saoPauloDate } from "../lib/billing/config";
import { GET as callbackGET } from "../app/api/instagram/callback/route";
import { POST as zernioAccountPOST } from "../app/api/zernio/accounts/route";
import { createOAuthState, encryptToken, OAUTH_NONCE_COOKIE } from "../lib/meta/oauth";

const providerScope = "10000000-0000-4000-8000-000000000001";
const workspaces = ["workspace-a", "workspace-a2", "workspace-a3", "workspace-b"];
let sql: Client;
async function createAccount(workspaceId: string, instagramId: string, options: { id?: string; connectedAt?: Date } = {}) {
  return withCommercialAccountCapacity(workspaceId, instagramId, tx => tx.instagramAccount.create({ data: { workspaceId, instagramId, username: instagramId, accessToken: "fixture-encrypted-token", ...options } }));
}
async function paid(workspaceId: string, planId: BillingPlanId = "pro-v1") {
  const plan = BILLING_PLANS[planId], dueDate = saoPauloDate(new Date()).slice(0, 7) + "-01", ending = monthlyInvoicePeriod(dueDate, 1).endsAt;
  const checkout = await state.db.billingCheckout.create({ data: { workspaceId, environment: "sandbox", accountScope: providerScope, requestId: randomUUID(), planId, amountCents: plan.amountCents, firstChargeDate: dueDate, billingAnchorDay: 1, status: "COMPLETED", providerCheckoutId: randomUUID() } });
  const sub = await state.db.billingSubscription.create({ data: { workspaceId, environment: "sandbox", accountScope: providerScope, providerSubscriptionId: "sub_" + randomUUID().replaceAll("-", ""), providerCustomerId: "cus_fixture", checkoutId: checkout.id, planId, amountCents: plan.amountCents, billingAnchorDay: 1, renewalStatus: "ACTIVE" } });
  await state.db.billingPayment.create({ data: { workspaceId, subscriptionId: sub.id, environment: "sandbox", accountScope: providerScope, providerPaymentId: "pay_" + randomUUID().replaceAll("-", ""), amountCents: plan.amountCents, dueDate, status: "CONFIRMED", deleted: false } });
  await state.db.workspaceBilling.update({ where: { workspaceId }, data: { currentSubscriptionId: sub.id, status: "ACTIVE", planId, paidThrough: ending } });
}
async function addMember(workspaceId: string, userId: string, email: string) {
  return state.db.$transaction(async tx => {
    await assertCommercialMemberCapacity(tx, workspaceId, { userId, email });
    return tx.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId, userId } }, create: { workspaceId, userId, role: "MEMBER" }, update: {} });
  });
}
function request(pathname: string, body: unknown) { return new NextRequest(`https://app.example.test${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
function callback(code: string) {
  const nonce = randomUUID(); remote.nonces.set(nonce, "owner-a|workspace-a");
  const query = new URLSearchParams({ code, state: createOAuthState("workspace-a", "owner-a", nonce) });
  return callbackGET(new NextRequest(`https://app.example.test/api/instagram/callback?${query}`, { headers: { cookie: `${OAUTH_NONCE_COOKIE}=${nonce}` } }));
}

describe.skipIf(!url)("commercial account and member capacity", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect(); await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const name of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) await sql.query(readFileSync(path.join(root, name, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10, options: `-c search_path=${schema}` }, { schema }) });
    for (const id of ["owner-a", "owner-b"]) await state.db.user.create({ data: { id, email: `${id}@example.test` } });
    for (const id of workspaces) await state.db.workspace.create({ data: { id, name: id, ownerId: id === "workspace-b" ? "owner-b" : "owner-a" } });
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", providerScope); vi.stubEnv("VERCEL_ENV", "test"); vi.stubEnv("FLY_APP_NAME", "local-capacity-test");
    state.context = { workspaceId: "workspace-a", userId: "owner-a", role: "OWNER" }; state.session = null;
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.test"); vi.stubEnv("NEXTAUTH_SECRET", "fixture-local-state-secret"); vi.stubEnv("ENCRYPTION_KEY", "11".repeat(32)); vi.stubEnv("INSTAGRAM_LOGIN_MODE", "legacy");
    remote.nonces.clear(); remote.exchange.mockReset().mockImplementation(async (code: string) => ({ accessToken: "fixture_" + code }));
    remote.longLived.mockReset().mockImplementation(async (accessToken: string) => ({ accessToken, expiresIn: 3600 }));
    remote.userInfo.mockReset().mockImplementation(async (token: string, id?: string) => ({ id: id ?? token.replace(/^fixture_/, ""), username: id ?? token.replace(/^fixture_/, ""), name: "Fixture" }));
    remote.subscribe.mockReset().mockResolvedValue({ success: true }); remote.facebookToken.mockReset().mockResolvedValue("fixture-facebook"); remote.permissions.mockReset().mockResolvedValue([]); remote.subscribePage.mockReset().mockResolvedValue({ success: true });
    remote.assigned.mockReset(); remote.pages.mockReset(); remote.zernioAccounts.mockReset();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Real HTTP forbidden"));
    await state.db.workspaceBilling.updateMany({ data: { currentSubscriptionId: null } });
    await state.db.billingPayment.deleteMany(); await state.db.billingCommand.deleteMany(); await state.db.billingEvent.deleteMany(); await state.db.billingSubscription.deleteMany(); await state.db.billingCheckout.deleteMany();
    await state.db.instagramAccount.deleteMany(); await state.db.workspaceInvitation.deleteMany(); await state.db.workspaceMember.deleteMany(); await state.db.workspaceBilling.deleteMany(); await state.db.trialRedemption.deleteMany();
    await state.db.zernioConnection.deleteMany(); await state.db.operationalEvent.deleteMany();
    await state.db.user.deleteMany({ where: { id: { notIn: ["owner-a", "owner-b"] } } });
    for (const id of workspaces) { await state.db.workspaceMember.create({ data: { workspaceId: id, userId: id === "workspace-b" ? "owner-b" : "owner-a", role: "OWNER" } }); await startCardFreeTrial(id); }
  });
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await state.db?.$disconnect(); if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });

  it("admits one trial account across20 concurrent connections into two owner workspaces", async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => createAccount(index % 2 ? "workspace-a" : "workspace-a2", `ig_${index}`)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "COMMERCIAL_ACCOUNT_LIMIT" });
    expect(await state.db.instagramAccount.count()).toBe(1);
    await createAccount("workspace-b", "other_owner"); expect(await state.db.instagramAccount.count()).toBe(2);
  });
  it("keeps paid workspace capacity separate from the owner's shared trial", async () => {
    await paid("workspace-a");
    await Promise.all([createAccount("workspace-a", "paid_a"), createAccount("workspace-a", "paid_b"), createAccount("workspace-a", "paid_c")]);
    await createAccount("workspace-a2", "trial_a");
    await expect(createAccount("workspace-a3", "trial_b")).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_LIMIT" });
    await expect(createAccount("workspace-a", "paid_fourth")).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_LIMIT" });
    expect(await state.db.instagramAccount.count()).toBe(4);
  });
  it("rejects foreign workspace IDs and reconnections never consume a second account slot", async () => {
    await createAccount("workspace-a", "owned_account");
    await withCommercialAccountCapacity("workspace-a", "owned_account", tx => tx.instagramAccount.updateMany({ where: { workspaceId: "workspace-a", instagramId: "owned_account" }, data: { username: "reconnected" } }));
    expect(await state.db.instagramAccount.count()).toBe(1);
    await expect(assertCommercialAccountUsable("workspace-a2", "owned_account")).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_NOT_AVAILABLE" });
    await expect(createAccount("workspace-b", "owned_account")).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_NOT_AVAILABLE" });
    await expect(assertCommercialAccountUsable("workspace-a", "absent_account")).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_NOT_AVAILABLE" });
    await expect(assertCommercialAccountUsable("workspace-a", "owned_account")).resolves.toBeUndefined();
  });
  it("preserves surplus connections after downgrade and permits only the oldestN with deterministic ID ties", async () => {
    await paid("workspace-a"); const oldest = new Date("2020-01-01T00:00:00Z");
    await createAccount("workspace-a", "ig_b", { id: "conn-b", connectedAt: oldest }); await createAccount("workspace-a", "ig_a", { id: "conn-a", connectedAt: oldest });
    await createAccount("workspace-a", "ig_c", { id: "conn-c", connectedAt: new Date("2020-01-02T00:00:00Z") });
    await paid("workspace-a", "essential-v1");
    await expect(assertCommercialAccountUsable("workspace-a", "ig_a")).resolves.toBeUndefined();
    for (const id of ["ig_b", "ig_c"]) await expect(assertCommercialAccountUsable("workspace-a", id)).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_LIMIT" });
    await withCommercialAccountCapacity("workspace-a", "ig_b", tx => tx.instagramAccount.updateMany({ where: { workspaceId: "workspace-a", instagramId: "ig_b" }, data: { username: "surplus_reconnect" } }));
    expect(await state.db.instagramAccount.count()).toBe(3); await expect(createAccount("workspace-a", "new_after_downgrade")).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_LIMIT" });
  });
  it("denies use/new connection/reconnection after exact trial expiry without deleting existing accounts", async () => {
    await createAccount("workspace-a", "trial_account"); const billing = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(billing.trialEndsAt);
    try {
      await expect(assertCommercialAccountUsable("workspace-a", "trial_account")).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_DENIED" });
      await expect(assertCommercialCapacityAccess("workspace-a")).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_DENIED" });
      await expect(createAccount("workspace-a2", "new_expired")).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_DENIED" });
      await expect(withCommercialAccountCapacity("workspace-a", "trial_account", tx => tx.instagramAccount.updateMany({ where: { workspaceId: "workspace-a" }, data: { username: "expired" } }))).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_DENIED" });
      expect(await state.db.instagramAccount.count()).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it("counts the trial owner once across workspaces and refuses extra members or pending invitations", async () => {
    await state.db.user.create({ data: { id: "trial-member", email: "trial-member@example.test" } });
    await expect(addMember("workspace-a", "trial-member", "trial-member@example.test")).rejects.toMatchObject({ code: "COMMERCIAL_MEMBER_LIMIT" });
    const response = await invitePOST(request("/api/workspace/members", { email: "invite@example.test" }));
    expect(response.status).toBe(409); expect(await state.db.workspaceInvitation.count()).toBe(0);
    expect(await state.db.workspaceMember.count({ where: { workspaceId: "workspace-a" } })).toBe(1);
  });
  it("atomically caps paid members including the owner under concurrent direct admission", async () => {
    await paid("workspace-a");
    for (let index = 0; index < 10; index++) await state.db.user.create({ data: { id: `member-${index}`, email: `member-${index}@example.test` } });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => addMember("workspace-a", `member-${index}`, `member-${index}@example.test`)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(await state.db.workspaceMember.count({ where: { workspaceId: "workspace-a" } })).toBe(3);
  });
  it("reserves valid pending invitations and consumes the reserved slot atomically on acceptance", async () => {
    await paid("workspace-a");
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => invitePOST(request("/api/workspace/members", { email: `invite-${index}@example.test` }))));
    expect(results.filter(result => result.status === 200)).toHaveLength(2); expect(results.filter(result => result.status === 409)).toHaveLength(8);
    const invitation = await state.db.workspaceInvitation.findFirstOrThrow({ where: { workspaceId: "workspace-a", status: "PENDING" } });
    await state.db.user.create({ data: { id: "accepted-member", email: invitation.email } }); state.session = { user: { id: "accepted-member", email: invitation.email } };
    const accepted = await acceptPOST(request("/api/workspace/invitations/accept", { token: invitation.token })); expect(accepted.status).toBe(200);
    expect(await state.db.workspaceMember.count({ where: { workspaceId: "workspace-a" } })).toBe(2);
    expect(await state.db.workspaceInvitation.count({ where: { workspaceId: "workspace-a", status: "PENDING" } })).toBe(1);
    expect((await invitePOST(request("/api/workspace/members", { email: "over-reserved@example.test" }))).status).toBe(409);
  });
  it("normalizes legitimate existing users and never changes an owner's role through reinvitation", async () => {
    await paid("workspace-a"); await state.db.user.create({ data: { id: "mixed-member", email: "Mixed@Example.test" } });
    expect((await invitePOST(request("/api/workspace/members", { email: "mixed@example.test" }))).status).toBe(200);
    expect(await state.db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: "workspace-a", userId: "mixed-member" } } })).not.toBeNull();
    expect(await state.db.workspaceInvitation.count()).toBe(0);
    expect((await invitePOST(request("/api/workspace/members", { email: "OWNER-A@example.test", role: "MEMBER" }))).status).toBe(200);
    expect((await state.db.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: "workspace-a", userId: "owner-a" } } })).role).toBe("OWNER");
  });
  it("does not double-count members' pending emails or expired invitations, and renews one reserved invitation", async () => {
    await paid("workspace-a"); await state.db.user.create({ data: { id: "registered-member", email: "Registered@Example.test" } });
    await addMember("workspace-a", "registered-member", "registered@example.test");
    for (const [email, expiresAt] of [["REGISTERED@example.test", new Date(Date.now() + 86400_000)], ["expired-a@example.test", new Date(0)], ["expired-b@example.test", new Date(0)]] as const) {
      await state.db.workspaceInvitation.create({ data: { workspaceId: "workspace-a", email, token: randomUUID(), expiresAt } });
    }
    expect((await invitePOST(request("/api/workspace/members", { email: "reserved@example.test" }))).status).toBe(200);
    const reserved = await state.db.workspaceInvitation.findUniqueOrThrow({ where: { workspaceId_email: { workspaceId: "workspace-a", email: "reserved@example.test" } } });
    expect((await invitePOST(request("/api/workspace/members", { email: "RESERVED@example.test" }))).status).toBe(200);
    expect((await state.db.workspaceInvitation.findUniqueOrThrow({ where: { workspaceId_email: { workspaceId: "workspace-a", email: "reserved@example.test" } } })).id).toBe(reserved.id);
    expect((await invitePOST(request("/api/workspace/members", { email: "beyond@example.test" }))).status).toBe(409);
  });
  it("fails closed when historical users share an ambiguous case-insensitive email", async () => {
    await paid("workspace-a");
    await state.db.user.createMany({ data: [{ id: "ambiguous-one", email: "duplicate@example.test" }, { id: "ambiguous-two", email: "Duplicate@example.test" }] });
    const response = await invitePOST(request("/api/workspace/members", { email: "DUPLICATE@example.test" }));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "COMMERCIAL_INVITATION_AMBIGUOUS" });
    expect(await state.db.workspaceMember.count({ where: { workspaceId: "workspace-a" } })).toBe(1); expect(await state.db.workspaceInvitation.count()).toBe(0);
  });
  it("leaves over-capacity invitations pending during automatic sign-in without granting a new seat", async () => {
    await paid("workspace-a"); await state.db.user.create({ data: { id: "waiting-member", email: "waiting@example.test" } });
    await state.db.workspaceInvitation.create({ data: { workspaceId: "workspace-a", email: "waiting@example.test", token: "fixture-waiting-token", expiresAt: new Date(Date.now() + 86400_000) } });
    await paid("workspace-a", "essential-v1");
    await acceptPendingInvitationsForUser("waiting-member", "WAITING@example.test");
    expect(await state.db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: "workspace-a", userId: "waiting-member" } } })).toBeNull();
    expect((await state.db.workspaceInvitation.findFirstOrThrow()).status).toBe("PENDING");
  });
  it("retains reads and member removal after expiry", async () => {
    await state.db.user.create({ data: { id: "legacy-member", email: "legacy@example.test" } });
    const member = await state.db.workspaceMember.create({ data: { workspaceId: "workspace-a", userId: "legacy-member", role: "MEMBER" } });
    const billing = await state.db.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: "workspace-a" } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(billing.trialEndsAt);
    try {
      expect((await memberGET()).status).toBe(200);
      const removed = await memberDELETE(new NextRequest("https://app.example.test/api/workspace/members", { method: "DELETE", body: JSON.stringify({ memberId: member.id }) }));
      expect(removed.status).toBe(200); expect(await state.db.workspaceMember.findUnique({ where: { id: member.id } })).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("caps concurrent single-account OAuth callbacks inside their real persistence transactions", async () => {
    state.session = { user: { id: "owner-a", email: "owner-a@example.test" } };
    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => callback(`oauth_${index}`)));
    expect(responses.filter(response => response.headers.get("location")?.includes("/dashboard"))).toHaveLength(1);
    expect(await state.db.instagramAccount.count()).toBe(1); expect(remote.nonces.size).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(["unified", "facebook"])("caps multiple-account %s OAuth imports and preserves reconnects", async mode => {
    vi.stubEnv("INSTAGRAM_LOGIN_MODE", mode); state.session = { user: { id: "owner-a", email: "owner-a@example.test" } };
    remote.assigned.mockResolvedValue({ accounts: Array.from({ length: 4 }, (_, index) => ({ id: `shared_${index}`, username: `shared_${index}` })), attempts: 1 });
    remote.pages.mockResolvedValue({ accounts: Array.from({ length: 4 }, (_, index) => ({ instagramId: `shared_${index}`, username: `shared_${index}`, pageId: `page_${index}`, pageAccessToken: "fixture-page-token" })), pageCount: 4 });
    expect((await callback("multiple")).headers.get("location")).toContain("/dashboard");
    const first = await state.db.instagramAccount.findFirstOrThrow();
    expect(await state.db.instagramAccount.count()).toBe(1);
    expect((await callback("multiple_again")).headers.get("location")).toContain("/dashboard");
    expect((await state.db.instagramAccount.findFirstOrThrow()).id).toBe(first.id);
    expect(await state.db.instagramAccount.count()).toBe(1); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("caps the real Zernio import transaction while allowing reconnection", async () => {
    await state.db.zernioConnection.create({ data: { workspaceId: "workspace-a", apiKey: encryptToken("fixture-zernio-key"), profileId: "fixture-profile", webhookId: "fixture-webhook", webhookSecret: encryptToken("fixture-secret") } });
    remote.zernioAccounts.mockResolvedValue([{ id: "remote-one", instagramId: "ig_zernio_one", username: "fixture_one", name: "Fixture" }, { id: "remote-two", instagramId: "ig_zernio_two", username: "fixture_two", name: "Fixture" }]);
    expect((await zernioAccountPOST(request("/api/zernio/accounts", { accountId: "remote-one" }))).status).toBe(200);
    expect((await zernioAccountPOST(request("/api/zernio/accounts", { accountId: "remote-one" }))).status).toBe(200);
    expect((await zernioAccountPOST(request("/api/zernio/accounts", { accountId: "remote-two" }))).status).toBe(409);
    expect(await state.db.instagramAccount.count()).toBe(1); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("accepts a reserved invitation only once under twenty concurrent requests", async () => {
    await paid("workspace-a");
    expect((await invitePOST(request("/api/workspace/members", { email: "racing@example.test" }))).status).toBe(200);
    const invitation = await state.db.workspaceInvitation.findFirstOrThrow();
    await state.db.user.create({ data: { id: "racing-member", email: invitation.email } }); state.session = { user: { id: "racing-member", email: invitation.email } };
    const results = await Promise.all(Array.from({ length: 20 }, () => acceptPOST(request("/api/workspace/invitations/accept", { token: invitation.token }))));
    expect(results.filter(response => response.status === 200)).toHaveLength(1);
    expect(results.every(response => [200, 404, 409].includes(response.status))).toBe(true);
    expect(await state.db.workspaceMember.count({ where: { workspaceId: "workspace-a" } })).toBe(2);
    expect((await state.db.workspaceInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe("ACCEPTED");
  });
});
