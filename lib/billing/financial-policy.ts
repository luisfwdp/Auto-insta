import { zonedDateTimeToUtc } from "@/lib/publishing/schedule";

/** Pure policy proposal. This module performs no I/O and never grants a trial. */
export const BILLING_TIME_ZONE = "America/Sao_Paulo";
export type FinancialPolicyErrorCode = "INVALID_QUOTE" | "INVALID_RECORD" | "INVALID_DATE" | "ANCHOR_MISMATCH" | "LINK_MISMATCH" | "RECONCILIATION_REQUIRED";
export class FinancialPolicyError extends Error {
  constructor(readonly code: FinancialPolicyErrorCode) {
    super(`Financial policy rejected input: ${code}`);
    this.name = "FinancialPolicyError";
  }
}

export interface FinancialQuote {
  workspaceId: string;
  environment: "sandbox" | "production";
  accountId: string;
  customerId: string;
  subscriptionId: string;
  planId: string;
  amountCents: number;
  cycle: "MONTHLY";
  /** Immutable first contractual due-day, including clamped February invoices. */
  billingAnchorDay: number;
  /** Informational only: cancellation stops renewal, not an already paid period. */
  renewalStatus?: "ACTIVE" | "CANCELED" | "INACTIVE";
}

export type FinancialPaymentStatus = "PENDING" | "RECEIVED" | "CONFIRMED" | "OVERDUE" | "REFUNDED" | "RECEIVED_IN_CASH"
  | "REFUND_REQUESTED" | "REFUND_IN_PROGRESS" | "CHARGEBACK_REQUESTED" | "CHARGEBACK_DISPUTE"
  | "AWAITING_CHARGEBACK_REVERSAL" | "DUNNING_REQUESTED" | "DUNNING_RECEIVED" | "AWAITING_RISK_ANALYSIS";

/** Canonical invoice snapshots, NOT a chronological list of raw webhook events.
 * workspaceId/cycle must come from the persisted binding/quote, not an incoming
 * unverified provider payload. One invocation covers one immutable quote version.
 */
export interface FinancialPaymentRecord {
  id: string;
  workspaceId: string;
  environment: "sandbox" | "production";
  accountId: string;
  customerId: string;
  subscriptionId: string;
  amountCents: number;
  cycle: "MONTHLY";
  dueDate: string;
  status: FinancialPaymentStatus;
  deleted: boolean;
}

export interface MonthlyInvoicePeriod { startsAt: Date; endsAt: Date }
export interface PaidAccessDecision {
  paidThrough: Date | null;
  status: "ACTIVE" | "EXPIRED";
  planId: string | null;
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function calendarDate(value: string) {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) throw new FinancialPolicyError("INVALID_DATE");
  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new FinancialPolicyError("INVALID_DATE");
  return { year, month, day };
}

/** Calendar-month interval [local midnight dueDate, local midnight next dueDate).
 * Supply the contractual anchor for recurring invoices: Feb 28 with anchor 31
 * ends Mar 31. No UTC-midnight shortcut, rolling +30 days or implicit grace.
 * An unrepresentable local midnight fails closed; no invented DST adjustment.
 */
export function monthlyInvoicePeriod(dueDate: string, anchorDay?: number): MonthlyInvoicePeriod {
  const { year, month, day } = calendarDate(dueDate);
  const anchor = anchorDay ?? day;
  if (!Number.isInteger(anchor) || anchor < 1 || anchor > 31) throw new FinancialPolicyError("INVALID_DATE");
  if (day !== Math.min(anchor, daysInMonth(year, month))) throw new FinancialPolicyError("ANCHOR_MISMATCH");
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  if (nextYear > 9999) throw new FinancialPolicyError("INVALID_DATE");
  const nextDate = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(Math.min(anchor, daysInMonth(nextYear, nextMonth))).padStart(2, "0")}`;
  try {
    const startsAt = zonedDateTimeToUtc(dueDate, "00:00", BILLING_TIME_ZONE);
    const endsAt = zonedDateTimeToUtc(nextDate, "00:00", BILLING_TIME_ZONE);
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) throw new Error();
    return { startsAt, endsAt };
  } catch { throw new FinancialPolicyError("INVALID_DATE"); }
}

const paymentStatuses = new Set<FinancialPaymentStatus>(["PENDING", "RECEIVED", "CONFIRMED", "OVERDUE", "REFUNDED", "RECEIVED_IN_CASH",
  "REFUND_REQUESTED", "REFUND_IN_PROGRESS", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL",
  "DUNNING_REQUESTED", "DUNNING_RECEIVED", "AWAITING_RISK_ANALYSIS"]);
const paid = (record: FinancialPaymentRecord) => !record.deleted && (record.status === "CONFIRMED" || record.status === "RECEIVED");
const opaqueId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const providerId = (value: unknown, prefix: string) => opaqueId(value) && (value as string).startsWith(`${prefix}_`) && (value as string).length > prefix.length + 1;
const validAmount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function validateQuote(quote: FinancialQuote) {
  if (!quote || !opaqueId(quote.workspaceId) || !opaqueId(quote.accountId) || !providerId(quote.customerId, "cus")
    || !providerId(quote.subscriptionId, "sub") || !opaqueId(quote.planId) || !validAmount(quote.amountCents)
    || !["sandbox", "production"].includes(quote.environment) || quote.cycle !== "MONTHLY"
    || !Number.isInteger(quote.billingAnchorDay) || quote.billingAnchorDay < 1 || quote.billingAnchorDay > 31
    || (quote.renewalStatus !== undefined && !["ACTIVE", "CANCELED", "INACTIVE"].includes(quote.renewalStatus))) throw new FinancialPolicyError("INVALID_QUOTE");
}

/** Deterministic reduction of the FULL canonical ledger for this quote/binding.
 * Raw webhook arrival order cannot resolve conflicting snapshots. Exact duplicates
 * and CONFIRMED/RECEIVED equivalents coalesce; all other same-ID divergences must
 * be reconciled by the caller before this policy can derive an entitlement.
 *
 * Grant the union of paid intervals, not a sum of webhook counts or invoice
 * amounts. Only the connected interval containing now may set a future deadline;
 * a paid future month across a gap cannot grant early access. Cancellation of
 * renewal and external subscription status do not establish financial settlement.
 */
export function derivePaidAccess(records: readonly FinancialPaymentRecord[], quote: FinancialQuote, now: Date): PaidAccessDecision {
  validateQuote(quote);
  if (!Array.isArray(records) || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new FinancialPolicyError("INVALID_RECORD");
  const unique = new Map<string, { fingerprint: string; period: MonthlyInvoicePeriod; record: FinancialPaymentRecord }>();
  for (const record of records) {
    if (!record || !providerId(record.id, "pay") || !opaqueId(record.workspaceId) || !opaqueId(record.accountId)
      || !providerId(record.customerId, "cus") || !providerId(record.subscriptionId, "sub") || !validAmount(record.amountCents)
      || !["sandbox", "production"].includes(record.environment) || record.cycle !== "MONTHLY"
      || !paymentStatuses.has(record.status) || typeof record.deleted !== "boolean") throw new FinancialPolicyError("INVALID_RECORD");
    const period = monthlyInvoicePeriod(record.dueDate, quote.billingAnchorDay);
    const settlement = record.status === "CONFIRMED" || record.status === "RECEIVED" ? "PAID" : record.status;
    const fingerprint = JSON.stringify([record.workspaceId, record.environment, record.accountId, record.customerId, record.subscriptionId,
      record.amountCents, record.cycle, record.dueDate, settlement, record.deleted]);
    const existing = unique.get(record.id);
    if (existing && existing.fingerprint !== fingerprint) throw new FinancialPolicyError("RECONCILIATION_REQUIRED");
    if (!existing) unique.set(record.id, { fingerprint, period, record });
  }
  // Check the complete duplicate set first, so a conflicting binding for the same
  // payment always requests reconciliation regardless of input ordering.
  for (const { record } of unique.values()) {
    if (record.workspaceId !== quote.workspaceId || record.environment !== quote.environment || record.accountId !== quote.accountId
      || record.customerId !== quote.customerId || record.subscriptionId !== quote.subscriptionId
      || record.amountCents !== quote.amountCents || record.cycle !== quote.cycle) throw new FinancialPolicyError("LINK_MISMATCH");
  }

  const intervals = [...unique.values()].filter(({ record }) => paid(record)).map(({ period }) => period)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.endsAt.getTime() - b.endsAt.getTime());
  const merged: MonthlyInvoicePeriod[] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval.startsAt <= previous.endsAt) {
      if (interval.endsAt > previous.endsAt) previous.endsAt = new Date(interval.endsAt);
    } else merged.push({ startsAt: new Date(interval.startsAt), endsAt: new Date(interval.endsAt) });
  }
  const active = merged.find(interval => interval.startsAt <= now && now < interval.endsAt);
  if (active) return { paidThrough: new Date(active.endsAt), status: "ACTIVE", planId: quote.planId };
  const historical = merged.filter(interval => interval.endsAt <= now).at(-1);
  return { paidThrough: historical ? new Date(historical.endsAt) : null, status: "EXPIRED", planId: historical ? quote.planId : null };
}
