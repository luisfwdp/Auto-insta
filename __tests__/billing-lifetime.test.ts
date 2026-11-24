import { afterEach, describe, expect, it, vi } from "vitest";
import { BILLING_PLANS } from "../lib/billing/catalog";
import { evaluateCommercialEntitlement, type CommercialEntitlementInput } from "../lib/billing/entitlements";
import { commercialScopeKey, type LifetimeAccessSnapshot } from "../lib/billing/lifetime";
import { billingStatusSchema, billingUsageSchema, createBrowserCheckout, BillingBrowserError } from "../lib/billing/browser-contract";

const now = new Date("2027-03-15T12:00:00Z");
const grant: LifetimeAccessSnapshot = { id: "10000000-0000-4000-8000-000000000001", workspaceId: "workspace-a", ownerId: "owner-a", planId: "agency-v1",
  grantedAt: new Date("2026-11-23T23:00:00Z"), grantedBy: "fixture-operator", reason: "Authorized lifetime license", approvalReference: "fixture-approved-request", revokedAt: null };
function input(patch: Partial<LifetimeAccessSnapshot> = {}): CommercialEntitlementInput {
  return { workspace: { id: "workspace-a", ownerId: "owner-a" }, billing: { workspaceId: "workspace-a", status: "TRIALING", trialStartedAt: new Date("2026-11-18T00:00:00Z"),
    trialEndsAt: new Date("2026-11-21T00:00:00Z"), paidThrough: null, planId: null, currentSubscriptionId: null, lifetimeAccess: { ...grant, ...patch } },
    trialRedemption: null, providerScope: null, currentSubscription: null, payments: [] };
}
afterEach(() => vi.unstubAllEnvs());
describe("audited lifetime access", () => {
  it("authorizes the bound workspace after trial expiry without financial evidence or a provider", () => {
    const decision = evaluateCommercialEntitlement(input(), now);
    expect(decision).toMatchObject({ status: "lifetime", code: "WORKSPACE_LIFETIME_ACTIVE", subjectKind: "WORKSPACE_GRANT", subjectId: grant.id, planId: "agency-v1",
      periodStart: new Date("2027-03-01T03:00:00Z"), periodEnd: new Date("2027-04-01T03:00:00Z") });
    expect(decision.limits).toEqual({ accounts: 10, members: 5, dms: 30000, publications: 1000, storageBytes: 30000000000, transferBytes: 80000000000 });
    expect(input().billing?.paidThrough).toBeNull();
  });
  it.each([
    { workspaceId: "workspace-b" }, { ownerId: "owner-b" }, { id: "invalid" }, { planId: "__proto__" },
    { planId: "unknown" }, { grantedAt: new Date("2030-01-01T00:00:00Z") }, { grantedAt: new Date(NaN) },
    { grantedBy: "" }, { reason: " " }, { approvalReference: "" }, { revokedAt: now },
  ])("does not grant access for invalid, foreign or revoked evidence: %j", patch => {
    expect(evaluateCommercialEntitlement(input(patch), now).status).toBe("denied");
  });
  it("does not override a workspace suspension", () => {
    const value = input(); value.billing!.status = "SUSPENDED";
    expect(evaluateCommercialEntitlement(value, now)).toMatchObject({ status: "denied", code: "SUSPENDED" });
  });
  it("keeps the license valid decades later while renewing quota in Sao Paulo calendar months", () => {
    const before = evaluateCommercialEntitlement(input(), new Date("2050-04-01T02:59:59Z"));
    const after = evaluateCommercialEntitlement(input(), new Date("2050-04-01T03:00:00Z"));
    expect(before).toMatchObject({ status: "lifetime", subjectId: grant.id, periodEnd: new Date("2050-04-01T03:00:00Z") });
    expect(after).toMatchObject({ status: "lifetime", subjectId: grant.id, periodStart: new Date("2050-04-01T03:00:00Z") });
  });
  it("isolates grant metering from trial and Asaas and never returns mutable catalog limits", () => {
    vi.stubEnv("ASAAS_ENVIRONMENT", "invalid"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", "invalid");
    const decision = evaluateCommercialEntitlement(input(), now);
    if (decision.status !== "lifetime") throw new Error("Expected lifetime fixture");
    expect(commercialScopeKey(decision)).toBe("workspace-lifetime-v1");
    decision.limits.dms = 1;
    expect(evaluateCommercialEntitlement(input(), now).limits?.dms).toBe(BILLING_PLANS["agency-v1"].dms);
  });
  it("accepts an explicit lifetime browser status without inventing paid-through or financial data", () => {
    expect(billingStatusSchema.parse({ enabled: true, status: "LIFETIME", hasAccess: true, planId: "agency-v1" })).toEqual({ enabled: true, status: "LIFETIME", hasAccess: true, planId: "agency-v1" });
    const decision = evaluateCommercialEntitlement(input(), now);
    if (decision.status !== "lifetime") throw new Error("Expected lifetime fixture");
    const dto = billingUsageSchema.parse({ hasAccess: true, kind: "lifetime", periodStart: decision.periodStart.toISOString(), periodEnd: decision.periodEnd.toISOString(), limits: decision.limits,
      usageVisibility: "AVAILABLE", counters: null, metering: { storage: "NOT_REPORTED", transfer: "NOT_METERED" }, grantId: grant.id, grantedBy: "private-operator" });
    expect(JSON.stringify(dto)).not.toContain("private-operator"); expect(JSON.stringify(dto)).not.toContain(grant.id);
  });
  it("clears only the known no-effect browser intent when the server rejects checkout for a lifetime license", async () => {
    const persist = vi.fn(); const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error: "LIFETIME_ACCESS_ACTIVE" }), { status: 409 }));
    await expect(createBrowserCheckout({ role: "OWNER", workspaceId: "workspace-a", requestId: "20000000-0000-4000-8000-000000000002", consent: true, previous: null, persist, fetcher,
      plan: { id: "essential-v1", name: "Essencial", amountCents: 7900, currency: "BRL", interval: "MONTHLY", trialDays: 3, cardRequiredForTrial: false, quotas: BILLING_PLANS["essential-v1"] } })).rejects.toBeInstanceOf(BillingBrowserError);
    expect(persist).toHaveBeenLastCalledWith(null); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
