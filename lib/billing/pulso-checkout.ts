import { z } from "zod";
import { AsaasError, checkedAsaasCheckoutLink, getAsaasCheckoutOrigin, readBoundedJson, type HostedCheckoutInput } from "./asaas-client";

const app = "ping-chat";
const checkout = z.object({
  app: z.literal(app),
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

export function createPulsoCheckoutClient(
  environment: "sandbox" | "production",
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (env.PULSO_CHECKOUT_ENABLED !== "true") return undefined;

  const token = env.PULSO_APP_TOKEN;
  const bypass = env.PULSO_PROTECTION_BYPASS;
  const origin = getAsaasCheckoutOrigin(env);
  let url: URL;
  try {
    url = new URL(env.PULSO_CHECKOUT_ORIGIN ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.href !== `${url.origin}/`
      || !origin.startsWith("https://") || env.PULSO_CHECKOUT_ENVIRONMENT !== environment
      || !token || !/^pulso_[A-Za-z0-9_-]{43}$/.test(token)
      || (bypass && !/^[A-Za-z0-9_-]{16,256}$/.test(bypass))) throw new Error();
  } catch { throw new AsaasError("CONFIGURATION"); }

  return async function createHostedCheckout(input: HostedCheckoutInput) {
    const callback = (result: string) => `${origin}/settings/billing?checkout=${encodeURIComponent(input.reference)}&result=${result}`;
    try {
      const response = await fetcher(new URL("/api/checkouts", url), {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(18_000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(bypass && { "x-vercel-protection-bypass": bypass }),
        },
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
      const result = checkout.parse(await readBoundedJson(response));
      if (result.orderId !== input.reference || result.externalReference !== `${app}:${input.reference}`
        || result.value !== input.amountCents / 100 || result.dueDate !== input.firstChargeDate) throw new Error();
      return { id: result.providerId, url: checkedAsaasCheckoutLink(result.paymentUrl, environment) };
    } catch (error) {
      if (error instanceof AsaasError && error.code === "REJECTED") throw error;
      throw new AsaasError("UNKNOWN_OUTCOME");
    }
  };
}
