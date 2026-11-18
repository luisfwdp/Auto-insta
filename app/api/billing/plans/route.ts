import { BILLING_PLANS, BILLING_PLAN_IDS } from "@/lib/billing/catalog";
import { isBillingEnabled, CARD_FREE_TRIAL_DAYS } from "@/lib/billing/trial";
import { BillingError } from "@/lib/billing/config";
import { billingFailure, billingJson } from "@/lib/billing/http";

export async function GET() {
  try {
    if (!isBillingEnabled()) throw new BillingError("BILLING_DISABLED", 404);
    const plans = BILLING_PLAN_IDS.map(id => {
      const plan = BILLING_PLANS[id];
      return { id, name: plan.name, amountCents: plan.amountCents, currency: "BRL", interval: "MONTHLY", trialDays: CARD_FREE_TRIAL_DAYS, cardRequiredForTrial: false,
        quotas: { accounts: plan.accounts, members: plan.members, dms: plan.dms, publications: plan.publications, storageBytes: plan.storageBytes, transferBytes: plan.transferBytes } };
    });
    return billingJson({ plans });
  } catch (error) { return billingFailure(error); }
}
