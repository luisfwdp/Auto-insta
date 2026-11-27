import "server-only";
import { z } from "zod";
import { BILLING_PLAN_IDS, type BillingPlanId } from "./catalog";

export const pulsoOfferPlan = z.enum(BILLING_PLAN_IDS);
const referenceFormat = z.uuid();
const cookieName = (plan: BillingPlanId) => `pulso-offer-${plan}`;

export function offerCookie(plan: BillingPlanId, reference: string) {
  return { name: cookieName(plan), value: referenceFormat.parse(reference), httpOnly: true,
    secure: true, sameSite: "lax" as const, path: "/api/billing/checkout", maxAge: 90 * 60 };
}

export function readPulsoOfferReference(request: Request, plan: BillingPlanId) {
  if (process.env.PULSO_CHECKOUT_ENABLED !== "true") return undefined;
  const prefix = `${cookieName(plan)}=`;
  const matches = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim())
    .filter(value => value.startsWith(prefix));
  return referenceFormat.safeParse(matches.length === 1 ? matches[0].slice(prefix.length) : undefined).data;
}
