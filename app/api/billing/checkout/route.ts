import type { NextRequest } from "next/server";
import { checkoutRequest, requestCheckout, readCheckout } from "@/lib/billing/checkout";
import { BATIDA_REFERRAL_COOKIE, referralCode } from "@/lib/billing/batida-affiliate";
import { BillingError } from "@/lib/billing/config";
import { billingFailure, billingJson, billingResourceId, readBillingJson, requireBillingOwner } from "@/lib/billing/http";

export const maxDuration = 30;

function checkoutResponse(data: Awaited<ReturnType<typeof requestCheckout>>) {
  return { id: data.id, status: data.status, planId: data.planId, amountCents: data.amountCents, url: data.url };
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireBillingOwner(request, { write: true });
    const parsed = checkoutRequest.safeParse(await readBillingJson(request));
    if (!parsed.success) throw new BillingError("INVALID_REQUEST", 400);
    const referral = process.env.BATIDA_AFFILIATE_CHECKOUT_SECRET
      ? referralCode.safeParse(request.cookies.get(BATIDA_REFERRAL_COOKIE)?.value).data
      : undefined;
    const data = referral
      ? await requestCheckout(context.workspaceId, parsed.data, undefined, referral)
      : await requestCheckout(context.workspaceId, parsed.data);
    return billingJson(checkoutResponse(data), data.status === "CREATING" || data.status === "UNKNOWN" ? 202 : 200);
  } catch (error) { return billingFailure(error); }
}

export async function GET(request: NextRequest) {
  try {
    const context = await requireBillingOwner(request);
    return billingJson(checkoutResponse(await readCheckout(context.workspaceId, billingResourceId(request))));
  } catch (error) { return billingFailure(error); }
}
