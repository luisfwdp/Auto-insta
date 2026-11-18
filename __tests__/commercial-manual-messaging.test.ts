import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const state = vi.hoisted(() => ({ enabled: true, role: "OWNER", authenticated: true }));
const deps = vi.hoisted(() => ({ account: vi.fn(), createContext: vi.fn(), send: vi.fn(), rate: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: async () => "workspace_a" }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: async () => state.authenticated ? { workspaceId: "workspace_a", userId: "user_a", role: state.role } : null,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN" }));
vi.mock("@/lib/billing/trial", () => ({ isBillingEnabled: () => state.enabled }));
vi.mock("@/lib/instagram-accounts", () => ({ getWorkspaceInstagramAccount: deps.account }));
vi.mock("@/lib/api/manual-dm-rate-limit", () => ({ checkManualDmRateLimit: deps.rate }));
vi.mock("@/lib/db/client", () => ({ prisma: { operationalEvent: { create: deps.audit } } }));
vi.mock("@/lib/instagram/provider", () => ({ createInstagramContext: deps.createContext, sendDirectMessage: deps.send, getConversations: vi.fn(), MetaApiError: class extends Error {} }));
import { POST } from "../app/api/instagram/conversations/route";
import { BillingError } from "../lib/billing/config";
import { DeliveryUnconfirmedError } from "../lib/instagram/delivery-errors";
const account = { id: "account_a", instagramId: "ig_a", workspaceId: "workspace_a", provider: "META", accessToken: "fake" };
const requestId = "10000000-0000-4000-8000-000000000001";
const body = { instagramAccountId: "account_a", recipientId: "private_recipient", text: "private text", requestId };
const req = (input: unknown) => new NextRequest("https://app.example.test/api/instagram/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
beforeEach(() => {
  vi.clearAllMocks(); state.enabled = true; state.role = "OWNER"; state.authenticated = true;
  deps.account.mockResolvedValue(account); deps.rate.mockResolvedValue({ allowed: true }); deps.audit.mockResolvedValue({});
  deps.createContext.mockImplementation(async (_account, operationId) => ({ provider: "META", workspaceId: "workspace_a", instagramId: "ig_a", accessToken: "fake", operationId }));
  deps.send.mockResolvedValue({ message_id: "real_mid", recipient_id: body.recipientId });
});
afterAll(() => vi.restoreAllMocks());
describe("manual commercial send contract", () => {
  it.each(["OWNER", "ADMIN"])("accepts %s with a stable manual operation, owned account and no content in audit", async role => {
    state.role = role; const response = await POST(req(body)); expect(response.status).toBe(200);
    expect(deps.account).toHaveBeenCalledWith("workspace_a", "account_a"); expect(deps.createContext).toHaveBeenCalledWith(account, `manual:${requestId}`);
    expect(deps.send).toHaveBeenCalledWith({ context: expect.objectContaining({ workspaceId: "workspace_a", operationId: `manual:${requestId}` }), instagramAccountId: "ig_a", userId: body.recipientId, message: body.text });
    expect(JSON.stringify(deps.audit.mock.calls)).not.toContain(body.text); expect(JSON.stringify(deps.audit.mock.calls)).not.toContain(body.recipientId);
  });
  it.each([{ ...body, requestId: undefined }, { ...body, requestId: "invalid" }, { ...body, workspaceId: "workspace_b" }, { ...body, scope: "foreign" }, { ...body, text: 123 }, { ...body, recipientId: {} }])("rejects malformed or extra commercial fields before account lookup %#", async input => {
    const response = await POST(req(input)); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(deps.account).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
  });
  it("requires authentication and owner/admin role before any delivery", async () => {
    state.authenticated = false; expect((await POST(req(body))).status).toBe(401);
    state.authenticated = true; state.role = "MEMBER"; expect((await POST(req(body))).status).toBe(403); expect(deps.send).not.toHaveBeenCalled(); expect(deps.account).not.toHaveBeenCalled();
  });
  it("rejects a selected foreign account through the server workspace filter", async () => {
    deps.account.mockResolvedValue(null); expect((await POST(req({ ...body, instagramAccountId: "foreign_account" }))).status).toBe(400);
    expect(deps.account).toHaveBeenCalledWith("workspace_a", "foreign_account"); expect(deps.send).not.toHaveBeenCalled();
  });
  it("preserves legacy requests without requestId and the original one-argument context call", async () => {
    state.enabled = false; const { requestId: omitted, ...legacy } = body; expect(omitted).toBe(requestId);
    expect((await POST(req(legacy))).status).toBe(200); expect(deps.createContext).toHaveBeenCalledWith(account); expect(deps.send).toHaveBeenCalledOnce();
  });
  it.each([new BillingError("COMMERCIAL_QUOTA_EXCEEDED", 402), new DeliveryUnconfirmedError(new Error("fake_sensitive_detail"))])("returns fixed commercial failure classification without exception details %#", async error => {
    deps.send.mockRejectedValue(error); const response = await POST(req(body));
    expect(response.status).toBe(error instanceof BillingError ? 402 : 503); const output = await response.json();
    expect(output.code).toBe(error instanceof BillingError ? "COMMERCIAL_QUOTA_EXCEEDED" : "DELIVERY_UNCONFIRMED");
    expect(JSON.stringify(output)).not.toContain("fake_sensitive_detail"); expect(JSON.stringify(deps.audit.mock.calls)).not.toContain(body.text);
  });
});
