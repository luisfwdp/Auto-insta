import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AsaasError, getAsaasCheckoutOrigin } from "./asaas-client";

export const BATIDA_REFERRAL_COOKIE = "batida_referral";
export const referralCodePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function verifiedBatidaReferral(code: string, search: URLSearchParams) {
  const secret = process.env.BATIDA_AFFILIATE_CHECKOUT_SECRET;
  const expires = search.get("expires");
  const proof = search.get("proof");
  if (!secret || !referralCodePattern.test(code) || !expires || !/^\d{10}$/.test(expires)
      || !proof || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const remaining = Number(expires) - Math.floor(Date.now() / 1000);
  if (remaining < 0 || remaining > 900) return false;
  const expected = createHmac("sha256", secret).update(`ping-chat.${code}.${expires}`).digest();
  return timingSafeEqual(expected, Buffer.from(proof, "hex"));
}


export const referralCode = z.uuid();

const checkoutResult = z.object({ providerId: z.uuid(), paymentUrl: z.url() });

export async function createPingAffiliateCheckout(input: {
  code: string;
  orderId: string;
  offer: string;
  cents: number;
  date: string;
  mode: "sandbox" | "production";
}) {
  const secret = process.env.BATIDA_AFFILIATE_CHECKOUT_SECRET;
  if (!secret) throw new AsaasError("CONFIGURATION");
  const origin = getAsaasCheckoutOrigin();
  const callback = (result: string) => {
    const url = new URL("/settings/billing", origin);
    url.searchParams.set("checkout", input.orderId);
    url.searchParams.set("result", result);
    return url.href;
  };

  let response: Response;
  try {
    response = await fetch("https://www.batidamedia.app/api/afiliados/checkout/ping-chat", {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(18_000),
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        orderId: input.orderId,
        offer: input.offer,
        expectedPriceCents: input.cents,
        mode: input.mode,
        dueOn: input.date,
        callback: {
          successUrl: callback("success"),
          cancelUrl: callback("canceled"),
          expiredUrl: callback("expired"),
        },
      }),
    });
  } catch { throw new AsaasError("UNKNOWN_OUTCOME"); }
  if (response.status === 422) throw new AsaasError("REJECTED");
  if (!response.ok || response.status === 202) throw new AsaasError("UNKNOWN_OUTCOME");
  const checkout = checkoutResult.parse(await response.json());
  const url = new URL(checkout.paymentUrl);
  const allowed = input.mode === "sandbox"
    ? ["https://sandbox.asaas.com"]
    : ["https://asaas.com", "https://www.asaas.com"];
  if (!allowed.includes(url.origin) || url.username || url.password) {
    throw new AsaasError("UNKNOWN_OUTCOME");
  }
  return { id: checkout.providerId, url: url.href };
}
