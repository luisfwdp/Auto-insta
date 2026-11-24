import { z } from "zod";
import { AsaasError, checkedAsaasCheckoutLink, getAsaasCheckoutOrigin, readBoundedJson, type HostedCheckoutInput } from "./asaas-client";

export const PULSO_APP = "ping-chat";
const checkout = z.object({
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
    return { id: result.providerId, url: checkedAsaasCheckoutLink(result.paymentUrl, environment) };
  }

  async function createHostedCheckout(input: HostedCheckoutInput) {
    const origin = getAsaasCheckoutOrigin(env);
    if (!origin.startsWith("https://")) throw new AsaasError("CONFIGURATION");
    const callback = (result: string) => `${origin}/settings/billing?checkout=${encodeURIComponent(input.reference)}&result=${result}`;
    try {
      const response = await send("/api/checkouts", {
        method: "POST",
        signal: AbortSignal.timeout(18_000),
        body: JSON.stringify({
          orderId: input.reference,
          description: input.name,
          value: input.amountCents / 100,
          minutesToExpire: 60,
          callback: { successUrl: callback("success"), cancelUrl: callback("canceled"), expiredUrl: callback("expired") },
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
      return parseCheckout(await readBoundedJson(response), input);
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
    return parseCheckout(orders.data[0], input);
  }

  return { request: (path: string, options: RequestInit) => send(`/api/billing${path}`, options), createHostedCheckout, findCheckout };
}
