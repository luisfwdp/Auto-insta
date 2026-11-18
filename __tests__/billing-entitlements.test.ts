import { describe, expect, it } from "vitest";
import { BILLING_PLANS, TRIAL_LIMITS } from "../lib/billing/catalog";
import { evaluateCommercialEntitlement, type CommercialEntitlementInput, type CommercialSubscriptionSnapshot } from "../lib/billing/entitlements";
import type { FinancialPaymentRecord } from "../lib/billing/financial-policy";

const scope = "10000000-0000-4000-8000-000000000001", subId = "20000000-0000-4000-8000-000000000002";
const at = (value: string) => new Date(value);
const now = at("2027-02-15T12:00:00Z");
function invoice(patch: Partial<FinancialPaymentRecord> = {}): FinancialPaymentRecord {
  return { id: "pay_invoice_1", workspaceId: "workspace_a", environment: "production", accountId: scope, customerId: "cus_authorized",
    subscriptionId: "sub_authorized", amountCents: 14900, cycle: "MONTHLY", dueDate: "2027-01-31", status: "CONFIRMED", deleted: false, ...patch };
}
function paidInput(): CommercialEntitlementInput {
  return { workspace: { id: "workspace_a", ownerId: "owner_a" }, trialRedemption: null, providerScope: { environment: "production", accountScope: scope },
    billing: { workspaceId: "workspace_a", status: "ACTIVE", trialStartedAt: at("2027-01-01T12:00:00Z"), trialEndsAt: at("2027-01-04T12:00:00Z"),
      paidThrough: at("2027-02-28T03:00:00Z"), planId: "pro-v1", currentSubscriptionId: subId },
    currentSubscription: { id: subId, workspaceId: "workspace_a", environment: "production", accountScope: scope, providerSubscriptionId: "sub_authorized",
      providerCustomerId: "cus_authorized", planId: "pro-v1", amountCents: 14900, billingAnchorDay: 31 }, payments: [invoice()] };
}
function trialInput(): CommercialEntitlementInput {
  const started = at("2027-02-14T12:00:00Z"), ended = at("2027-02-17T12:00:00Z");
  return { workspace: { id: "workspace_a", ownerId: "owner_a" }, providerScope: null, currentSubscription: null, payments: [],
    billing: { workspaceId: "workspace_a", status: "TRIALING", trialStartedAt: started, trialEndsAt: ended, paidThrough: null, planId: null, currentSubscriptionId: null },
    trialRedemption: { ownerId: "owner_a", trialStartedAt: started, trialEndsAt: ended } };
}
function expectDenied(input: CommercialEntitlementInput, code: string, clock = now) {
  expect(evaluateCommercialEntitlement(input, clock)).toEqual({ status: "denied", code, subjectKind: null, subjectId: null, periodStart: null, periodEnd: null, limits: null });
}

describe("global owner trial entitlement", () => {
  it("uses the owner subject and exact three-day global window, independent of provider configuration", () => {
    const input = trialInput();
    expect(evaluateCommercialEntitlement(input, now)).toEqual({ status: "trial", code: "OWNER_TRIAL_ACTIVE", subjectKind: "OWNER_TRIAL", subjectId: "owner_a",
      periodStart: at("2027-02-14T12:00:00Z"), periodEnd: at("2027-02-17T12:00:00Z"), limits: TRIAL_LIMITS });
    input.providerScope = { environment: "production", accountScope: "invalid" };
    expect(evaluateCommercialEntitlement(input, now).status).toBe("trial");
  });
  it("cannot gain a fresh quota subject or deadline by replacing a workspace under the same owner", () => {
    const first = trialInput(), second = trialInput(); second.workspace.id = "workspace_b"; second.billing!.workspaceId = "workspace_b";
    expect(evaluateCommercialEntitlement(first, now)).toEqual(evaluateCommercialEntitlement(second, now));
  });
  it("includes the exact start, excludes the exact end, and rejects a future trial", () => {
    const input = trialInput();
    expect(evaluateCommercialEntitlement(input, input.trialRedemption!.trialStartedAt).status).toBe("trial");
    expectDenied(input, "TRIAL_NOT_ACTIVE", at("2027-02-14T11:59:59.999Z"));
    expect(evaluateCommercialEntitlement(input, at("2027-02-17T11:59:59.999Z")).status).toBe("trial");
    expectDenied(input, "TRIAL_NOT_ACTIVE", at("2027-02-17T12:00:00Z"));
  });
  it("requires a redemption owned by the current authoritative workspace owner", () => {
    const input = trialInput(); input.trialRedemption = null; expectDenied(input, "TRIAL_REDEMPTION_MISMATCH");
    input.trialRedemption = trialInput().trialRedemption; input.workspace.ownerId = "owner_b"; expectDenied(input, "TRIAL_REDEMPTION_MISMATCH");
  });
  it.each(["billing start", "billing end", "redemption duration", "invalid date"])("rejects a forged or malformed %s", field => {
    const input = trialInput();
    if (field === "billing start") input.billing!.trialStartedAt = at("2027-02-14T12:00:00.001Z");
    if (field === "billing end") input.billing!.trialEndsAt = at("2027-02-17T12:00:00.001Z");
    if (field === "redemption duration") { input.trialRedemption!.trialEndsAt = at("2027-02-18T12:00:00Z"); input.billing!.trialEndsAt = input.trialRedemption!.trialEndsAt; }
    if (field === "invalid date") input.trialRedemption!.trialStartedAt = new Date(NaN);
    expectDenied(input, "TRIAL_REDEMPTION_MISMATCH");
  });
  it("never falls back to trial when billing claims ACTIVE without settlement", () => {
    const input = trialInput(); input.billing!.status = "ACTIVE";
    expectDenied(input, "PROVIDER_SCOPE_INVALID");
  });
});

describe("canonical paid commercial entitlement", () => {
  it("grants the versioned plan limits for a current canonical paid invoice", () => {
    expect(evaluateCommercialEntitlement(paidInput(), now)).toEqual({ status: "paid", code: "WORKSPACE_PAID_ACTIVE", subjectKind: "WORKSPACE_PAID", subjectId: "workspace_a",
      periodStart: at("2027-01-31T03:00:00Z"), periodEnd: at("2027-02-28T03:00:00Z"), limits: { accounts: 3, members: 3, dms: 10000, publications: 300, storageBytes: 10000000000, transferBytes: 30000000000 } });
  });
  it.each(["ACTIVE", "CANCELED", "PAST_DUE"] as const)("retains a canonical paid period under billing status %s", status => {
    const input = paidInput(); input.billing!.status = status;
    expect(evaluateCommercialEntitlement(input, now).status).toBe("paid");
  });
  it.each(["trial", "paid"])("SUSPENDED denies an otherwise valid %s proof", kind => {
    const input = kind === "trial" ? trialInput() : paidInput(); input.billing!.status = "SUSPENDED";
    expectDenied(input, "SUSPENDED");
  });
  it("does not use raw future paidThrough, ACTIVE metadata or missing settlement as payment proof", () => {
    const input = paidInput(); input.payments = []; input.billing!.paidThrough = at("2099-01-01T03:00:00Z");
    expectDenied(input, "PAYMENT_NOT_CURRENT");
  });
  it.each(["REFUNDED", "OVERDUE", "PENDING", "REFUND_REQUESTED", "CHARGEBACK_REQUESTED", "RECEIVED_IN_CASH"] as const)("a %s invoice cannot grant access despite a future paid summary", status => {
    const input = paidInput(); input.payments = [invoice({ status })]; expectDenied(input, "PAYMENT_NOT_CURRENT");
  });
  it("ignores deleted paid invoices and rejects unrecognized external statuses", () => {
    const input = paidInput(); input.payments = [invoice({ deleted: true })]; expectDenied(input, "PAYMENT_NOT_CURRENT");
    input.payments = [invoice({ status: "ACTIVE" as never })]; expectDenied(input, "PAYMENT_EVIDENCE_INVALID");
  });
  it("coalesces CONFIRMED/RECEIVED for one invoice while refusing conflicting raw snapshots", () => {
    const input = paidInput(); input.payments = [invoice(), invoice({ status: "RECEIVED" }), invoice()];
    expect(evaluateCommercialEntitlement(input, now)).toEqual(evaluateCommercialEntitlement(paidInput(), now));
    input.payments = [invoice(), invoice({ status: "REFUNDED" })]; expectDenied(input, "PAYMENT_EVIDENCE_INVALID");
    input.payments = [...input.payments].reverse(); expectDenied(input, "PAYMENT_EVIDENCE_INVALID");
  });
  it("old overdue/refunded invoices cannot remove a newer confirmed period", () => {
    const input = paidInput(); input.payments = [invoice({ id: "pay_old", dueDate: "2026-12-31", status: "REFUNDED" }), invoice(), invoice({ id: "pay_older", dueDate: "2026-11-30", status: "OVERDUE" })];
    expect(evaluateCommercialEntitlement(input, now)).toEqual(evaluateCommercialEntitlement(paidInput(), now));
  });
  it.each(["2099-01-01T03:00:00Z", "2027-02-27T03:00:00Z"])("requires summary deadline %s to equal the complete canonical paid union", deadline => {
    const input = paidInput(); input.billing!.paidThrough = at(deadline); expectDenied(input, "PAID_SUMMARY_MISMATCH");
  });
  it("enforces both exact summary expiry and the canonical invoice start", () => {
    const input = paidInput();
    expectDenied(input, "PAYMENT_NOT_CURRENT", at("2027-01-31T02:59:59.999Z"));
    expect(evaluateCommercialEntitlement(input, at("2027-01-31T03:00:00Z")).status).toBe("paid");
    expect(evaluateCommercialEntitlement(input, at("2027-02-28T02:59:59.999Z")).status).toBe("paid");
    expectDenied(input, "PAID_SUMMARY_EXPIRED", at("2027-02-28T03:00:00Z"));
  });
  it("uses the current invoice as the quota period even with several adjacent prepaid months", () => {
    const input = paidInput(); input.payments = [invoice(), invoice({ id: "pay_feb", dueDate: "2027-02-28" }), invoice({ id: "pay_mar", dueDate: "2027-03-31" })];
    input.billing!.paidThrough = at("2027-04-30T03:00:00Z");
    expect(evaluateCommercialEntitlement(input, now)).toMatchObject({ status: "paid", periodStart: at("2027-01-31T03:00:00Z"), periodEnd: at("2027-02-28T03:00:00Z") });
    expect(evaluateCommercialEntitlement(input, at("2027-03-15T12:00:00Z"))).toMatchObject({ status: "paid", periodStart: at("2027-02-28T03:00:00Z"), periodEnd: at("2027-03-31T03:00:00Z") });
    expect(evaluateCommercialEntitlement(input, at("2027-03-31T03:00:00Z"))).toMatchObject({ status: "paid", periodStart: at("2027-03-31T03:00:00Z"), periodEnd: at("2027-04-30T03:00:00Z") });
  });
  it("does not advance access into a gap just because a later month is paid", () => {
    const input = paidInput(); input.payments = [invoice(), invoice({ id: "pay_future", dueDate: "2027-03-31" })]; input.billing!.paidThrough = at("2027-04-30T03:00:00Z");
    expectDenied(input, "PAID_SUMMARY_MISMATCH"); expectDenied(input, "PAYMENT_NOT_CURRENT", at("2027-03-15T12:00:00Z"));
    input.payments = [invoice({ id: "pay_future", dueDate: "2027-03-31" })]; expectDenied(input, "PAYMENT_NOT_CURRENT");
  });
  it.each([
    [31, "2027-02-28", "2027-03-15T12:00:00Z", "2027-03-31T03:00:00Z"],
    [31, "2024-02-29", "2024-03-15T12:00:00Z", "2024-03-31T03:00:00Z"],
    [29, "2027-02-28", "2027-03-15T12:00:00Z", "2027-03-29T03:00:00Z"],
    [29, "2024-02-29", "2024-03-15T12:00:00Z", "2024-03-29T03:00:00Z"],
    [31, "2027-04-30", "2027-05-15T12:00:00Z", "2027-05-31T03:00:00Z"],
  ] as const)("keeps anchor%s through dueDate%s, using local midnight instead of UTC or30 days", (anchor, dueDate, clock, endsAt) => {
    const input = paidInput(); input.currentSubscription!.billingAnchorDay = anchor; input.payments = [invoice({ dueDate })]; input.billing!.paidThrough = at(endsAt);
    expect(evaluateCommercialEntitlement(input, at(clock))).toMatchObject({ status: "paid", periodStart: at(`${dueDate}T03:00:00Z`), periodEnd: at(endsAt) });
  });
  it("rejects a paid invoice whose due-day disagrees with its immutable anchor", () => {
    const input = paidInput(); input.payments = [invoice({ dueDate: "2027-01-30" })]; expectDenied(input, "PAYMENT_EVIDENCE_INVALID");
  });
  it.each(["essential-v1", "pro-v1", "agency-v1"] as const)("uses only the immutable %s catalog price and resource limits", planId => {
    const input = paidInput(), plan = BILLING_PLANS[planId]; input.currentSubscription!.planId = planId; input.currentSubscription!.amountCents = plan.amountCents; input.billing!.planId = planId;
    input.payments = [invoice({ amountCents: plan.amountCents })];
    expect(evaluateCommercialEntitlement(input, now)).toMatchObject({ status: "paid", limits: { accounts: plan.accounts, members: plan.members, dms: plan.dms, publications: plan.publications, storageBytes: plan.storageBytes, transferBytes: plan.transferBytes } });
  });
});

describe("entitlement binding and fail-closed contract", () => {
  it("denies missing billing, a foreign workspace projection and malformed workspace/clock data", () => {
    const input = paidInput(); input.billing = null; expectDenied(input, "BILLING_NOT_STARTED");
    input.billing = paidInput().billing; input.billing!.workspaceId = "workspace_b"; expectDenied(input, "WORKSPACE_MISMATCH");
    input.workspace.ownerId = ""; expectDenied(input, "INVALID_INPUT");
    expectDenied(paidInput(), "INVALID_INPUT", new Date(NaN));
  });
  it.each([null, { environment: "sandbox", accountScope: scope }, { environment: "production", accountScope: "invalid" }] as CommercialEntitlementInput["providerScope"][])("requires a valid provider scope that matches the current subscription %#", providerScope => {
    const input = paidInput(); input.providerScope = providerScope; expectDenied(input, providerScope?.accountScope === scope ? "SUBSCRIPTION_MISMATCH" : "PROVIDER_SCOPE_INVALID");
  });
  it.each([{ id: "30000000-0000-4000-8000-000000000003" }, { workspaceId: "workspace_b" }, { environment: "sandbox" },
    { accountScope: "30000000-0000-4000-8000-000000000003" }] as Partial<CommercialSubscriptionSnapshot>[])("rejects a foreign current subscription binding %#", patch => {
    const input = paidInput(); input.currentSubscription = { ...input.currentSubscription!, ...patch }; expectDenied(input, "SUBSCRIPTION_MISMATCH");
  });
  it("requires the actual current-subscription pointer rather than a merely associated subscription", () => {
    const input = paidInput(); input.billing!.currentSubscriptionId = null; expectDenied(input, "SUBSCRIPTION_MISMATCH");
    input.billing!.currentSubscriptionId = subId; input.currentSubscription = null; expectDenied(input, "SUBSCRIPTION_MISMATCH");
  });
  it.each(["pro-v2", "toString", "__proto__", "constructor"])("rejects an unknown or inherited plan %s", planId => {
    const input = paidInput(); input.currentSubscription!.planId = planId; input.billing!.planId = planId; expectDenied(input, "PLAN_MISMATCH");
  });
  it("requires billing plan and snapshot price to match the server-side version", () => {
    const input = paidInput(); input.billing!.planId = "agency-v1"; expectDenied(input, "PLAN_MISMATCH");
    input.billing!.planId = "pro-v1"; input.currentSubscription!.amountCents = 7900; expectDenied(input, "PLAN_MISMATCH");
  });
  it.each([{ workspaceId: "workspace_b" }, { environment: "sandbox" }, { accountId: "other_scope" }, { customerId: "cus_foreign" },
    { subscriptionId: "sub_foreign" }, { amountCents: 29900 }, { cycle: "YEARLY" as never }] as Partial<FinancialPaymentRecord>[])("validates all canonical payment tenant/provider/quote fields %#", patch => {
    const input = paidInput(); input.payments = [invoice(patch)]; expectDenied(input, "PAYMENT_EVIDENCE_INVALID");
  });
  it("returns only a fixed denial code when provider data is malformed", () => {
    const input = paidInput(); input.currentSubscription!.providerCustomerId = "secret-provider-marker"; expectDenied(input, "PAYMENT_EVIDENCE_INVALID");
    expect(JSON.stringify(evaluateCommercialEntitlement(input, now))).not.toContain("secret-provider-marker");
  });
  it("exposes neither provider identifiers nor mutable references to catalog/date inputs", () => {
    const input = paidInput(), original = JSON.stringify(input), decision = evaluateCommercialEntitlement(input, now);
    const output = JSON.stringify(decision); for (const privateId of [scope, subId, "sub_authorized", "cus_authorized"]) expect(output).not.toContain(privateId);
    expect(Object.keys(decision).sort()).toEqual(["code", "limits", "periodEnd", "periodStart", "status", "subjectId", "subjectKind"]);
    if (decision.status === "denied") throw new Error("Expected an allowed decision");
    decision.periodEnd.setUTCFullYear(2099); decision.limits.dms = 1; decision.limits.storageBytes = 0;
    expect(JSON.stringify(input)).toBe(original); expect(evaluateCommercialEntitlement(input, now).limits?.dms).toBe(10000);
    const trial = trialInput(), trialDecision = evaluateCommercialEntitlement(trial, now);
    if (trialDecision.status === "denied") throw new Error("Expected trial decision");
    trialDecision.periodStart.setUTCFullYear(2099); trialDecision.limits.dms = 1;
    expect(evaluateCommercialEntitlement(trial, now).limits).toEqual(TRIAL_LIMITS);
  });
});
