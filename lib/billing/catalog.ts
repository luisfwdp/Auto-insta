/** Versioned server-side offers. Never mutate a sold version's price or quotas. */
export const BILLING_PLANS = {
  "essential-v1": { name: "Essencial", amountCents: 7900, accounts: 1, members: 1, dms: 2000, publications: 120, storageBytes: 3_000_000_000, transferBytes: 10_000_000_000 },
  "pro-v1": { name: "Pro", amountCents: 14900, accounts: 3, members: 3, dms: 10000, publications: 300, storageBytes: 10_000_000_000, transferBytes: 30_000_000_000 },
  "agency-v1": { name: "Agência", amountCents: 29900, accounts: 10, members: 5, dms: 30000, publications: 1000, storageBytes: 30_000_000_000, transferBytes: 80_000_000_000 },
} as const;
export type BillingPlanId = keyof typeof BILLING_PLANS;
export const BILLING_PLAN_IDS = ["essential-v1", "pro-v1", "agency-v1"] as const;
// A signed video upload reserves the bucket's full technical cap (300 MiB in
// the deployment checklist), so a useful trial needs more than 300 MB decimal.
export const TRIAL_LIMITS = { accounts: 1, members: 1, dms: 100, publications: 10, storageBytes: 1_000_000_000, transferBytes: 500_000_000 } as const;
