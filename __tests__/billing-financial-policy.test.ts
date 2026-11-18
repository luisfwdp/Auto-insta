// Integration destination: __tests__/billing-financial-policy.test.ts.
import { describe, expect, it } from "vitest";
import { derivePaidAccess, FinancialPolicyError, monthlyInvoicePeriod, type FinancialPaymentRecord, type FinancialQuote } from "../lib/billing/financial-policy";

const quote: FinancialQuote = { workspaceId: "workspace_a", environment: "sandbox", accountId: "account_a", customerId: "cus_a", subscriptionId: "sub_a",
  planId: "pro_v1", amountCents: 14900, cycle: "MONTHLY", billingAnchorDay: 31 };
const invoice = (patch: Partial<FinancialPaymentRecord> = {}): FinancialPaymentRecord => ({ id: "pay_1_invoice_a", workspaceId: quote.workspaceId,
  environment: quote.environment, accountId: quote.accountId, customerId: quote.customerId, subscriptionId: quote.subscriptionId,
  amountCents: quote.amountCents, cycle: quote.cycle, dueDate: "2027-01-31", status: "CONFIRMED", deleted: false, ...patch });
const at = (iso: string) => new Date(iso);
const currentTime = at("2027-02-15T12:00:00.000Z");

function expectPolicyError(action: () => unknown, code: FinancialPolicyError["code"]) {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(FinancialPolicyError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected financial policy error ${code}`);
}

describe("monthly invoice calendar in America/Sao_Paulo", () => {
  it.each([
    ["2027-01-31", undefined, "2027-01-31T03:00:00.000Z", "2027-02-28T03:00:00.000Z"],
    ["2024-01-31", undefined, "2024-01-31T03:00:00.000Z", "2024-02-29T03:00:00.000Z"],
    ["2027-02-28", 31, "2027-02-28T03:00:00.000Z", "2027-03-31T03:00:00.000Z"],
    ["2024-02-29", 31, "2024-02-29T03:00:00.000Z", "2024-03-31T03:00:00.000Z"],
    ["2027-02-28", undefined, "2027-02-28T03:00:00.000Z", "2027-03-28T03:00:00.000Z"],
    ["2027-12-31", 31, "2027-12-31T03:00:00.000Z", "2028-01-31T03:00:00.000Z"],
    ["2018-10-31", 31, "2018-10-31T03:00:00.000Z", "2018-11-30T02:00:00.000Z"],
  ] as const)("calculates %s with anchor %s as calendar boundaries, including DST", (dueDate, anchor, start, end) => {
    const period = monthlyInvoicePeriod(dueDate, anchor);
    expect(period.startsAt.toISOString()).toBe(start); expect(period.endsAt.toISOString()).toBe(end);
  });
  it.each(["2027-02-29", "2100-02-29", "2027-04-31", "2027-00-01", "2027-13-01", "2027-01-00", "2027-1-31", "2027-01-31T00:00:00Z", "9999-12-31"])("rejects invalid/unsupported calendar input %s", value => {
    expectPolicyError(() => monthlyInvoicePeriod(value), "INVALID_DATE");
  });
  it("uses Gregorian century leap rules and rejects non-existent local midnight instead of inventing grace", () => {
    expect(monthlyInvoicePeriod("2000-01-31", 31).endsAt.toISOString().slice(0, 10)).toBe("2000-02-29");
    expectPolicyError(() => monthlyInvoicePeriod("2018-11-04"), "INVALID_DATE");
  });
  it.each([0, 32, 1.5, NaN])("rejects invalid contractual anchor %s", anchor => {
    expectPolicyError(() => monthlyInvoicePeriod("2027-01-31", anchor), "INVALID_DATE");
  });
  it("rejects invoice dates that contradict the contracted anchor", () => {
    expectPolicyError(() => monthlyInvoicePeriod("2027-01-30", 31), "ANCHOR_MISMATCH");
    expectPolicyError(() => monthlyInvoicePeriod("2027-02-27", 31), "ANCHOR_MISMATCH");
  });
});

describe("canonical financial ledger entitlement", () => {
  it("grants only the paid invoice interval, including its start and excluding its end", () => {
    const records = [invoice()];
    expect(derivePaidAccess(records, quote, at("2027-01-31T03:00:00Z"))).toEqual({ status: "ACTIVE", planId: quote.planId, paidThrough: at("2027-02-28T03:00:00Z") });
    expect(derivePaidAccess(records, quote, at("2027-01-31T02:59:59.999Z"))).toEqual({ status: "EXPIRED", paidThrough: null, planId: null });
    expect(derivePaidAccess(records, quote, at("2027-02-28T03:00:00Z"))).toEqual({ status: "EXPIRED", planId: quote.planId, paidThrough: at("2027-02-28T03:00:00Z") });
  });
  it("coalesces CONFIRMED/RECEIVED plus repeated events for one invoice without extending another month", () => {
    const records = [invoice(), invoice({ status: "RECEIVED" }), invoice(), invoice({ status: "RECEIVED" })];
    expect(derivePaidAccess(records, quote, currentTime)).toEqual(derivePaidAccess([invoice()], quote, currentTime));
    expect(derivePaidAccess(records, quote, currentTime).paidThrough).toEqual(at("2027-02-28T03:00:00Z"));
  });
  it("unions paid invoice periods instead of adding a month for every distinct payment id", () => {
    expect(derivePaidAccess([invoice(), invoice({ id: "pay_same_period" })], quote, currentTime).paidThrough).toEqual(at("2027-02-28T03:00:00Z"));
  });
  it("keeps the contractual day through clamped February and joins prepaid adjacent months without gaps", () => {
    const records = [invoice(), invoice({ id: "pay_feb", dueDate: "2027-02-28", status: "RECEIVED" }), invoice({ id: "pay_mar", dueDate: "2027-03-31" })];
    expect(derivePaidAccess(records, quote, currentTime).paidThrough).toEqual(at("2027-04-30T03:00:00Z"));
    expect(derivePaidAccess(records, quote, at("2027-03-29T12:00:00Z")).status).toBe("ACTIVE");
    const leap = [invoice({ dueDate: "2024-01-31" }), invoice({ id: "pay_leap", dueDate: "2024-02-29" })];
    expect(derivePaidAccess(leap, quote, at("2024-03-30T12:00:00Z")).paidThrough).toEqual(at("2024-03-31T03:00:00Z"));
  });
  it("does not use an isolated future invoice or bridge an unpaid gap to extend access", () => {
    const future = invoice({ id: "pay_future", dueDate: "2027-03-31" });
    expect(derivePaidAccess([future], quote, currentTime)).toEqual({ status: "EXPIRED", paidThrough: null, planId: null });
    expect(derivePaidAccess([invoice(), future], quote, currentTime).paidThrough).toEqual(at("2027-02-28T03:00:00Z"));
    expect(derivePaidAccess([invoice(), future], quote, at("2027-03-15T12:00:00Z"))).toEqual({ status: "EXPIRED", paidThrough: at("2027-02-28T03:00:00Z"), planId: quote.planId });
  });
  it.each(["OVERDUE", "REFUNDED"] as const)("old %s never removes a newer paid interval regardless of input order", status => {
    const old = invoice({ id: "pay_old", dueDate: "2026-12-31", status });
    const expected = derivePaidAccess([invoice()], quote, currentTime);
    expect(derivePaidAccess([old, invoice()], quote, currentTime)).toEqual(expected);
    expect(derivePaidAccess([invoice(), old], quote, currentTime)).toEqual(expected);
  });
  it("refund of the only current invoice removes access; older paid history cannot manufacture a future deadline", () => {
    expect(derivePaidAccess([invoice({ status: "REFUNDED" })], quote, currentTime)).toEqual({ status: "EXPIRED", paidThrough: null, planId: null });
    expect(derivePaidAccess([invoice({ id: "pay_old", dueDate: "2026-12-31" }), invoice({ status: "REFUNDED" })], quote, currentTime)).toEqual({ status: "EXPIRED", paidThrough: at("2027-01-31T03:00:00Z"), planId: quote.planId });
  });
  it("canceling renewal keeps an already paid period, but ACTIVE subscription metadata cannot create access", () => {
    expect(derivePaidAccess([invoice()], { ...quote, renewalStatus: "CANCELED" }, currentTime)).toEqual(derivePaidAccess([invoice()], { ...quote, renewalStatus: "ACTIVE" }, currentTime));
    expect(derivePaidAccess([], { ...quote, renewalStatus: "ACTIVE" }, currentTime)).toEqual({ status: "EXPIRED", paidThrough: null, planId: null });
  });
  it.each(["PENDING", "OVERDUE", "REFUNDED", "RECEIVED_IN_CASH", "REFUND_REQUESTED", "REFUND_IN_PROGRESS", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL", "DUNNING_REQUESTED", "DUNNING_RECEIVED", "AWAITING_RISK_ANALYSIS"] as const)("does not infer settlement from %s", status => {
    expect(derivePaidAccess([invoice({ status })], quote, currentTime).status).toBe("EXPIRED");
  });
  it("deleted invoice, checkout callback and external ACTIVE status cannot grant access", () => {
    expect(derivePaidAccess([invoice({ deleted: true })], quote, currentTime).paidThrough).toBeNull();
    for (const status of ["ACTIVE", "CHECKOUT_PAID", "success"]) expectPolicyError(() => derivePaidAccess([invoice({ status: status as never })], quote, currentTime), "INVALID_RECORD");
  });
  it.each([
    { workspaceId: "workspace_b" }, { environment: "production" }, { accountId: "account_b" }, { customerId: "cus_b" },
    { subscriptionId: "sub_b" }, { amountCents: 7900 },
  ] as Partial<FinancialPaymentRecord>[])("rejects foreign tenant/provider/quote linkage %# before deriving access", patch => {
    expectPolicyError(() => derivePaidAccess([invoice(patch)], quote, currentTime), "LINK_MISMATCH");
  });
  it("rejects cycles outside the server-side monthly contract and invoices off the contractual anchor", () => {
    expectPolicyError(() => derivePaidAccess([invoice({ cycle: "YEARLY" as never })], quote, currentTime), "INVALID_RECORD");
    expectPolicyError(() => derivePaidAccess([invoice({ dueDate: "2027-01-30" })], quote, currentTime), "ANCHOR_MISMATCH");
  });
  it.each([{ status: "OVERDUE" }, { status: "REFUNDED" }, { deleted: true }, { dueDate: "2027-02-28" }, { amountCents: 7900 }, { workspaceId: "workspace_b" }, { customerId: "cus_b" }] as Partial<FinancialPaymentRecord>[])("requires reconciliation for conflicting same-ID snapshots in either order %#", patch => {
    const conflict = invoice(patch);
    expectPolicyError(() => derivePaidAccess([invoice(), conflict], quote, currentTime), "RECONCILIATION_REQUIRED");
    expectPolicyError(() => derivePaidAccess([conflict, invoice()], quote, currentTime), "RECONCILIATION_REQUIRED");
  });
  it("is deterministic, does not mutate caller data, and returns detached dates", () => {
    const records = Object.freeze([Object.freeze(invoice({ id: "pay_feb", dueDate: "2027-02-28", status: "RECEIVED" })), Object.freeze(invoice())]);
    const time = new Date(currentTime), fixedQuote = Object.freeze({ ...quote });
    const before = JSON.stringify(records);
    const decision = derivePaidAccess(records, fixedQuote, time);
    expect(derivePaidAccess([...records].reverse(), fixedQuote, time)).toEqual(decision);
    decision.paidThrough!.setUTCFullYear(2040);
    expect(derivePaidAccess(records, fixedQuote, time).paidThrough).toEqual(at("2027-03-31T03:00:00Z"));
    expect(time).toEqual(currentTime); expect(JSON.stringify(records)).toBe(before);
  });
  it.each([{ billingAnchorDay: 0 }, { billingAnchorDay: 32 }, { amountCents: 149.5 }, { amountCents: 0 }, { cycle: "YEARLY" as never }, { subscriptionId: "../sub_a" }] as Partial<FinancialQuote>[])("rejects invalid server quote %#", patch => {
    expectPolicyError(() => derivePaidAccess([], { ...quote, ...patch }, currentTime), "INVALID_QUOTE");
  });
  it("rejects malformed ledger/clock data using typed errors without carrying payload data", () => {
    expectPolicyError(() => derivePaidAccess([invoice({ id: "pay_../secret" })], quote, currentTime), "INVALID_RECORD");
    expectPolicyError(() => derivePaidAccess([], quote, new Date(NaN)), "INVALID_RECORD");
    const error = new FinancialPolicyError("RECONCILIATION_REQUIRED");
    expect(Object.keys(error).sort()).toEqual(["code", "name"]);
  });
});
