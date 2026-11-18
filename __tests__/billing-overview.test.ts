import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ row: null as unknown, enabled: false, configured: true, context: { workspaceId: "workspace-a" } as unknown,
  find: vi.fn(), count: vi.fn(), legacy: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { workspaceBilling: { findUnique: state.find }, billingCommand: { count: state.count } } }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: async () => state.context }));
vi.mock("@/lib/billing/config", () => ({ getBillingProviderScope: () => ({ environment: "sandbox", accountScope: "scope-a" }), hasBillingProviderScope: () => state.configured }));
vi.mock("@/lib/billing/trial", async original => ({ ...await original(), isBillingEnabled: () => state.enabled, getWorkspaceBillingStatus: state.legacy }));
import { readBillingOverview } from "../lib/billing/overview";
import { GET } from "../app/api/billing/status/route";

describe("billing status during sales rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.enabled = false; state.configured = true; state.context = { workspaceId: "workspace-a" };
    state.row = { workspaceId: "workspace-a", status: "ACTIVE", trialStartedAt: new Date(Date.now() - 5 * 86400000), trialEndsAt: new Date(Date.now() - 2 * 86400000),
      paidThrough: new Date(Date.now() + 86400000), planId: "pro-v1", providerCustomerId: "private-customer", providerSubscriptionId: "private-subscription", syncLeaseToken: "private-token",
      currentSubscription: { id: "private-local-sub", workspaceId: "workspace-a", environment: "sandbox", accountScope: "scope-a", renewalStatus: "ACTIVE" } };
    state.find.mockImplementation(async () => state.row); state.count.mockResolvedValue(1);
  });
  it("keeps cancellation visible while sales are disabled without returning internal fields", async () => {
    const response = await GET(), body = await response.json();
    expect(body.data).toMatchObject({ enabled: false, canCancelRenewal: true, cancellationPending: true, hasAccess: true });
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(JSON.stringify(body)).not.toContain("private-");
    expect(state.find.mock.calls[0][0].where).toEqual({ workspaceId: "workspace-a" });
    expect(state.count.mock.calls[0][0].where).toMatchObject({ workspaceId: "workspace-a", subscriptionId: "private-local-sub" });
  });
  it.each([{ workspaceId: "workspace-b" }, { environment: "production" }, { accountScope: "other-scope" }])("never exposes another binding's cancellation path %#", async patch => {
    const row = state.row as { currentSubscription: object }; row.currentSubscription = { ...row.currentSubscription, ...patch };
    expect(await readBillingOverview("workspace-a")).toMatchObject({ hasAccess: false, canCancelRenewal: false, cancellationPending: false }); expect(state.count).not.toHaveBeenCalled();
  });
  it("does not query new tables on an unconfigured disabled self-hosted deployment", async () => {
    state.configured = false;
    expect(await (await GET()).json()).toEqual({ success: true, data: { enabled: false } }); expect(state.find).not.toHaveBeenCalled(); expect(state.legacy).not.toHaveBeenCalled();
  });
  it("does not report paid access without a configured provider scope", async () => {
    state.enabled = true; state.configured = false;
    state.legacy.mockResolvedValue({ status: "ACTIVE", hasAccess: true, paidThrough: new Date(Date.now() + 86400000).toISOString() });
    expect((await (await GET()).json()).data).toMatchObject({ hasAccess: false, status: "REVIEW_REQUIRED" });
  });
  it("redacts database failures and rejects anonymous access", async () => {
    state.find.mockRejectedValue(new Error("private-secret-marker"));
    const response = await GET(); expect(response.status).toBe(503); expect(await response.json()).toEqual({ success: false, error: "BILLING_UNAVAILABLE" });
    state.context = null; const denied = await GET(); expect(denied.status).toBe(401); expect(denied.headers.get("cache-control")).toBe("no-store");
  });
});
