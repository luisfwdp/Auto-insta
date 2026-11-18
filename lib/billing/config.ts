import { z } from "zod";

export class BillingError extends Error {
  constructor(readonly code: string, readonly httpStatus = 409) { super("Billing request could not be completed"); this.name = "BillingError"; }
}

/** Stable per-provider-account scope; rotating the API key must not change it. */
export function getBillingProviderScope(env: Readonly<Record<string, string | undefined>> = process.env): { environment: "sandbox" | "production"; accountScope: string } {
  const environment = env.ASAAS_ENVIRONMENT;
  const scope = z.uuid().safeParse(env.ASAAS_ACCOUNT_SCOPE);
  if ((environment !== "sandbox" && environment !== "production") || !scope.success) throw new BillingError("BILLING_CONFIGURATION", 503);
  if ((env.VERCEL_ENV === "production" || env.FLY_APP_NAME === "criaping-worker") && environment !== "production") throw new BillingError("BILLING_CONFIGURATION", 503);
  return { environment, accountScope: scope.data };
}

export function hasBillingProviderScope() {
  try { getBillingProviderScope(); return true; } catch { return false; }
}

export function saoPauloDate(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
