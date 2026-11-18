import { isBillingEnabled } from "./trial";

/** Pause new sales without disabling paid access, quotas or financial recovery. */
export function isBillingSalesEnabled() {
  if (!isBillingEnabled()) return false;
  const configured = process.env.BILLING_SALES_ENABLED;
  // An omitted flag preserves existing commercial behavior. Empty/invalid
  // configured values fail closed instead of accidentally reopening sales.
  return configured === undefined || configured.trim().toLowerCase() === "true";
}
