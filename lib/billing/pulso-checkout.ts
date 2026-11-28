import { z } from "zod";
import { AsaasError, checkedAsaasCheckoutLink, getAsaasCheckoutOrigin, readBoundedJson, type HostedCheckoutInput } from "./asaas-client";
import { BILLING_PLANS } from "./catalog";
import { safePulsoCheckoutUrl } from "./checkout-links";

export const PULSO_APP = "ping-chat";
const checkout = z.object({
  id: z.uuid().optional(),
  app: z.literal(PULSO_APP),
  orderId: z.uuid(),
  externalReference: z.string(),
  kind: z.literal("checkout"),
  method: z.literal("CREDIT_CARD"),
  creationState: z.literal("CREATED"),
  providerId: z.uuid(),
  paymentUrl: z.string(),
  value: z.number(),
  dueDate: z.iso.date(),
});
const publicLink = z.object({ checkoutUrl: z.string(), expiresAt: z.iso.datetime({ offset: true }) });
const publicLinkFields = z.tuple([z.literal(PULSO_APP), z.string(), z.number().int(), z.uuid(), z.number().int()]);

export function createPulsoClient(
  environment: "sandbox" | "production",
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (env.PULSO_CHECKOUT_ENABLED !== "true") return undefined;

  const token = env.PULSO_APP_TOKEN;
  const bypass = env.PULSO_PROTECTION_BYPASS;
  let url: URL;
  try {
    url = new URL(env.PULSO_CHECKOUT_ORIGIN ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.href !== `${url.origin}/`
      || env.PULSO_CHECKOUT_ENVIRONMENT !== environment
      || !token || !/^pulso_[A-Za-z0-9_-]{43}$/.test(token)
      || (bypass && !/^[A-Za-z0-9_-]{16,256}$/.test(bypass))) throw new Error();
  } catch { throw new AsaasError("CONFIGURATION"); }

  function send(path: string, options: RequestInit) {
    return fetcher(new URL(path, url), {
      ...options, redirect: "error", cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        "x-pulso-environment": environment,
        ...(bypass && { "x-vercel-protection-bypass": bypass }),
      },
    });
  }

  function parseCheckout(value: unknown, input: Omit<HostedCheckoutInput, "name">) {
    const result = checkout.parse(value);
    if (result.orderId !== input.reference || result.externalReference !== `${PULSO_APP}:${input.reference}`
      || result.value !== input.amountCents / 100 || result.dueDate !== input.firstChargeDate) throw new Error();
    const paymentUrl = checkedAsaasCheckoutLink(result.paymentUrl, environment);
    const checkoutUrl = new URL(paymentUrl);
    if (checkoutUrl.pathname !== "/checkoutSession/show" || checkoutUrl.searchParams.size !== 1
      || checkoutUrl.searchParams.get("id") !== result.providerId) throw new Error();
    return { chargeId: result.id, id: result.providerId, url: paymentUrl };
  }

  async function catalogLink(chargeId: string, providerId: string, input: HostedCheckoutInput) {
    try {
      const response = await send(`/api/charges/${chargeId}/checkout-link`, { method: "GET", signal: AbortSignal.timeout(2000) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      const result = publicLink.parse(await readBoundedJson(response));
      const link = safePulsoCheckoutUrl(result.checkoutUrl);
      if (!link) return null;
      const encoded = new URL(link).pathname.split(".")[1];
      const [, plan, cents, id, expires] = publicLinkFields.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
      const expiresAt = Date.parse(result.expiresAt);
      const now = Date.now();
      if (plan !== input.planId || cents !== input.amountCents || id !== providerId || expires * 1000 !== expiresAt
        || expiresAt <= now || expiresAt > now + 60 * 60_000) return null;
      return link;
    } catch { return null; }
  }

  async function createHostedCheckout(input: HostedCheckoutInput) {
    const configuredOrigin = getAsaasCheckoutOrigin(env);
    if (!configuredOrigin.startsWith("https://")) throw new AsaasError("CONFIGURATION");
    const origin = input.planId && configuredOrigin === "https://pingchatbr.app" ? "https://www.pingchatbr.app" : configuredOrigin;
    const callback = (result: string) => `${origin}/settings/billing?checkout=${encodeURIComponent(input.reference)}&result=${result}`;
    const callbacks = { successUrl: callback("success"), cancelUrl: callback("canceled"), expiredUrl: callback("expired") };
    if (input.planId && BILLING_PLANS[input.planId].amountCents !== input.amountCents) throw new AsaasError("INVALID_REQUEST");
    try {
      const response = await send(input.planId ? "/api/commerce/ping-chat" : "/api/checkouts", {
        method: "POST",
        signal: AbortSignal.timeout(18_000),
        body: JSON.stringify(input.planId ? {
          orderId: input.reference, plan: input.planId, nextDueDate: input.firstChargeDate, callback: callbacks,
        } : {
          orderId: input.reference,
          description: input.name,
          value: input.amountCents / 100,
          minutesToExpire: 60,
          callback: callbacks,
          subscription: { cycle: "MONTHLY", nextDueDate: input.firstChargeDate },
        }),
      });
      if (response.status === 422) {
        const failure = z.object({ error: z.string() }).parse(await readBoundedJson(response));
        if (failure.error === "asaas_rejected" || failure.error === "invalid_input") throw new AsaasError("REJECTED", 422);
      }
      if (response.status !== 200 && response.status !== 201) {
        await response.body?.cancel().catch(() => {});
        throw new Error();
      }
      const { chargeId, id, url } = parseCheckout(await readBoundedJson(response), input);
      const branded = input.planId && chargeId && environment === "production" ? await catalogLink(chargeId, id, input) : null;
      return { id, url: branded ?? url };
    } catch (error) {
      if (error instanceof AsaasError && error.code === "REJECTED") throw error;
      throw new AsaasError("UNKNOWN_OUTCOME");
    }
  }

  async function findCheckout(input: Omit<HostedCheckoutInput, "name">) {
    const query = new URLSearchParams({ orderId: input.reference, limit: "2" });
    const response = await send(`/api/charges?${query}`, { method: "GET", signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new AsaasError("UNAVAILABLE", response.status);
    const orders = z.object({ app: z.literal(PULSO_APP), data: z.array(z.unknown()).length(1), nextOffset: z.null() })
      .parse(await readBoundedJson(response));
    const { id, url: paymentUrl } = parseCheckout(orders.data[0], input);
    return { id, url: paymentUrl };
  }

  return { request: (path: string, options: RequestInit) => send(`/api/billing${path}`, options), createHostedCheckout, findCheckout };
}
