import { z } from "zod";
import { BILLING_PLANS, TRIAL_LIMITS, type BillingPlanId } from "./catalog";
import { derivePaidAccess, monthlyInvoicePeriod, type FinancialPaymentRecord, type FinancialQuote } from "./financial-policy";
import { evaluateLifetimeAccess, type LifetimeAccessSnapshot, type LifetimeEntitlement } from "./lifetime";

export interface CommercialLimits {
  accounts: number;
  members: number;
  dms: number;
  publications: number;
  storageBytes: number;
  transferBytes: number;
}
export interface CommercialProviderScope { environment: "sandbox" | "production"; accountScope: string }
export interface CommercialBillingSnapshot {
  workspaceId: string;
  status: "TRIALING" | "ACTIVE" | "CANCELED" | "PAST_DUE" | "SUSPENDED";
  trialStartedAt: Date;
  trialEndsAt: Date;
  paidThrough: Date | null;
  planId: string | null;
  currentSubscriptionId: string | null;
  lifetimeAccess?: LifetimeAccessSnapshot | null;
}
export interface CommercialSubscriptionSnapshot extends CommercialProviderScope {
  id: string;
  workspaceId: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  planId: string;
  amountCents: number;
  billingAnchorDay: number;
}
/** Trusted, scoped database projections only; never accept these from a browser.
 * payments is the full canonical ledger of the current subscription's quote,
 * normalized to FinancialPaymentRecord by the loader. No API key belongs here.
 * BillingCheckout snapshots are monthly; the reducer verifies that cycle again.
 */
export interface CommercialEntitlementInput {
  workspace: { id: string; ownerId: string };
  billing: CommercialBillingSnapshot | null;
  trialRedemption: { ownerId: string; trialStartedAt: Date; trialEndsAt: Date } | null;
  providerScope: CommercialProviderScope | null;
  currentSubscription: CommercialSubscriptionSnapshot | null;
  payments: readonly FinancialPaymentRecord[];
}
export type CommercialEntitlementCode = "OWNER_TRIAL_ACTIVE" | "WORKSPACE_PAID_ACTIVE" | "WORKSPACE_LIFETIME_ACTIVE" | "INVALID_INPUT" | "BILLING_NOT_STARTED"
  | "WORKSPACE_MISMATCH" | "SUSPENDED" | "TRIAL_REDEMPTION_MISMATCH" | "TRIAL_NOT_ACTIVE" | "BILLING_STATUS_NOT_PAID"
  | "PROVIDER_SCOPE_INVALID" | "SUBSCRIPTION_MISMATCH" | "PLAN_MISMATCH" | "PAID_SUMMARY_EXPIRED"
  | "PAYMENT_EVIDENCE_INVALID" | "PAYMENT_NOT_CURRENT" | "PAID_SUMMARY_MISMATCH";
type DenialCode = Exclude<CommercialEntitlementCode, "OWNER_TRIAL_ACTIVE" | "WORKSPACE_PAID_ACTIVE" | "WORKSPACE_LIFETIME_ACTIVE">;
export type CommercialEntitlement = {
  status: "denied"; code: DenialCode; subjectKind: null; subjectId: null; periodStart: null; periodEnd: null; limits: null;
} | {
  status: "trial"; code: "OWNER_TRIAL_ACTIVE"; subjectKind: "OWNER_TRIAL"; subjectId: string; periodStart: Date; periodEnd: Date; limits: CommercialLimits;
} | {
  status: "paid"; code: "WORKSPACE_PAID_ACTIVE"; subjectKind: "WORKSPACE_PAID"; subjectId: string; periodStart: Date; periodEnd: Date; limits: CommercialLimits;
} | LifetimeEntitlement;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const date = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
const denied = (code: DenialCode): CommercialEntitlement => ({ status: "denied", code, subjectKind: null, subjectId: null, periodStart: null, periodEnd: null, limits: null });
function limits(value: CommercialLimits): CommercialLimits {
  return { accounts: value.accounts, members: value.members, dms: value.dms, publications: value.publications, storageBytes: value.storageBytes, transferBytes: value.transferBytes };
}

/** Pure access proof, with no legacy/flag bypass and no quota mutation.
 * Trial quota subject is the owner across all workspaces. Paid quota periods are
 * individual anchored monthly invoices, not the union of prepaid future months.
 * Storage occupancy and account/member caps require separate integration; the
 * usage ledger provides operation idempotency without implying those are ready.
 */
export function evaluateCommercialEntitlement(input: CommercialEntitlementInput, now: Date): CommercialEntitlement {
  try {
    if (!input || !input.workspace || !id(input.workspace.id) || !id(input.workspace.ownerId) || !date(now)) return denied("INVALID_INPUT");
    const { billing, workspace } = input;
    if (!billing) return denied("BILLING_NOT_STARTED");
    if (billing.workspaceId !== workspace.id) return denied("WORKSPACE_MISMATCH");
    if (billing.status === "SUSPENDED") return denied("SUSPENDED");
    const lifetime = evaluateLifetimeAccess(workspace, billing, now);
    if (lifetime) return lifetime;
    if (billing.status === "TRIALING") {
      const redemption = input.trialRedemption;
      if (!redemption || redemption.ownerId !== workspace.ownerId || !date(redemption.trialStartedAt) || !date(redemption.trialEndsAt)
        || !date(billing.trialStartedAt) || !date(billing.trialEndsAt)
        || redemption.trialEndsAt.getTime() - redemption.trialStartedAt.getTime() !== 72 * 60 * 60 * 1000
        || billing.trialStartedAt.getTime() !== redemption.trialStartedAt.getTime()
        || billing.trialEndsAt.getTime() !== redemption.trialEndsAt.getTime()) return denied("TRIAL_REDEMPTION_MISMATCH");
      if (now < redemption.trialStartedAt || now >= redemption.trialEndsAt) return denied("TRIAL_NOT_ACTIVE");
      return { status: "trial", code: "OWNER_TRIAL_ACTIVE", subjectKind: "OWNER_TRIAL", subjectId: workspace.ownerId,
        periodStart: new Date(redemption.trialStartedAt), periodEnd: new Date(redemption.trialEndsAt), limits: limits(TRIAL_LIMITS) };
    }
    if (!["ACTIVE", "CANCELED", "PAST_DUE"].includes(billing.status)) return denied("BILLING_STATUS_NOT_PAID");
    const scope = input.providerScope, sub = input.currentSubscription;
    if (!scope || !["sandbox", "production"].includes(scope.environment) || !z.uuid().safeParse(scope.accountScope).success) return denied("PROVIDER_SCOPE_INVALID");
    if (!sub || !z.uuid().safeParse(sub.id).success || sub.id !== billing.currentSubscriptionId || sub.workspaceId !== workspace.id
      || sub.environment !== scope.environment || sub.accountScope !== scope.accountScope) return denied("SUBSCRIPTION_MISMATCH");
    if (!Object.hasOwn(BILLING_PLANS, sub.planId) || billing.planId !== sub.planId) return denied("PLAN_MISMATCH");
    const plan = BILLING_PLANS[sub.planId as BillingPlanId];
    if (sub.amountCents !== plan.amountCents) return denied("PLAN_MISMATCH");
    if (!date(billing.paidThrough) || billing.paidThrough <= now) return denied("PAID_SUMMARY_EXPIRED");
    const quote: FinancialQuote = { workspaceId: workspace.id, environment: scope.environment, accountId: scope.accountScope,
      customerId: sub.providerCustomerId, subscriptionId: sub.providerSubscriptionId, planId: sub.planId,
      amountCents: sub.amountCents, cycle: "MONTHLY", billingAnchorDay: sub.billingAnchorDay };
    try {
      const proof = derivePaidAccess(input.payments, quote, now);
      if (proof.status !== "ACTIVE" || !proof.paidThrough || proof.planId !== sub.planId) return denied("PAYMENT_NOT_CURRENT");
      // The summary is a cache, not authority. Disagreement must reconcile before
      // granting access; neither a fabricated future deadline nor a stale summary
      // silently changes the canonical financial period.
      if (proof.paidThrough.getTime() !== billing.paidThrough.getTime()) return denied("PAID_SUMMARY_MISMATCH");
      const period = input.payments.filter(payment => !payment.deleted && (payment.status === "CONFIRMED" || payment.status === "RECEIVED"))
        .map(payment => monthlyInvoicePeriod(payment.dueDate, sub.billingAnchorDay)).find(period => period.startsAt <= now && now < period.endsAt);
      if (!period) return denied("PAYMENT_NOT_CURRENT");
      return { status: "paid", code: "WORKSPACE_PAID_ACTIVE", subjectKind: "WORKSPACE_PAID", subjectId: workspace.id,
        periodStart: new Date(period.startsAt), periodEnd: new Date(period.endsAt), limits: limits(plan) };
    } catch { return denied("PAYMENT_EVIDENCE_INVALID"); }
  } catch { return denied("INVALID_INPUT"); }
}
