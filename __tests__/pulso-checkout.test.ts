import { describe, expect, it, vi } from "vitest";
import { createPulsoCheckoutClient } from "../lib/billing/pulso-checkout";

const environment = {
  ASAAS_ENVIRONMENT: "sandbox",
  NEXTAUTH_URL: "https://ping.example.test",
  PULSO_CHECKOUT_ENABLED: "true",
  PULSO_CHECKOUT_ENVIRONMENT: "sandbox",
  PULSO_CHECKOUT_ORIGIN: "https://pulso.example.test",
  PULSO_APP_TOKEN: `pulso_${"a".repeat(43)}`,
  PULSO_PROTECTION_BYPASS: "test-protection-secret",
};
const input = {
  reference: "10000000-0000-4000-8000-000000000001",
  name: "PING CHAT — Pro",
  amountCents: 14900,
  firstChargeDate: "2026-11-23",
};
const result = {
  app: "ping-chat",
  orderId: input.reference,
  externalReference: `ping-chat:${input.reference}`,
  kind: "checkout",
  method: "CREDIT_CARD",
  creationState: "CREATED",
  providerId: "20000000-0000-4000-8000-000000000002",
  paymentUrl: "https://sandbox.asaas.com/checkoutSession/show?id=20000000-0000-4000-8000-000000000002",
  value: 149,
  dueDate: "2026-11-23",
};

describe("Pulso recurring checkout", () => {
  it("sends the immutable order to Pulso and returns the verified Asaas checkout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result, { status: 201 }));
    const createCheckout = createPulsoCheckoutClient("sandbox", environment, fetcher)!;
    await expect(createCheckout(input)).resolves.toEqual({ id: result.providerId, url: result.paymentUrl });
    const [[url, request]] = fetcher.mock.calls;
    expect(String(url)).toBe("https://pulso.example.test/api/checkouts");
    expect(request).toMatchObject({ method: "POST", redirect: "error", headers: {
      Authorization: `Bearer ${environment.PULSO_APP_TOKEN}`,
      "x-vercel-protection-bypass": environment.PULSO_PROTECTION_BYPASS,
    } });
    const billing = `https://ping.example.test/settings/billing?checkout=${input.reference}&result=`;
    expect(JSON.parse(String(request?.body))).toEqual({
      orderId: input.reference, description: input.name, value: 149, minutesToExpire: 60,
      callback: { successUrl: `${billing}success`, cancelUrl: `${billing}canceled`, expiredUrl: `${billing}expired` },
      subscription: { cycle: "MONTHLY", nextDueDate: input.firstChargeDate },
    });
  });

  it.each([
    [202, result],
    [502, { error: "asaas_unavailable" }],
    [201, { ...result, orderId: result.providerId }],
    [201, { ...result, value: 99 }],
    [201, { ...result, paymentUrl: "https://asaas.com/checkoutSession/show?id=other" }],
  ])("keeps the outcome uncertain after an unverified %s response", async (status, body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
    const createCheckout = createPulsoCheckoutClient("sandbox", environment, fetcher)!;
    await expect(createCheckout(input)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("recognizes a definitive provider rejection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "asaas_rejected" }, { status: 422 }));
    const createCheckout = createPulsoCheckoutClient("sandbox", environment, fetcher)!;
    await expect(createCheckout(input)).rejects.toMatchObject({ code: "REJECTED" });
  });

  it("requires consistent settings before checkout can be enabled", () => {
    expect(createPulsoCheckoutClient("sandbox", {})).toBeUndefined();
    expect(() => createPulsoCheckoutClient("production", environment)).toThrow();
    expect(() => createPulsoCheckoutClient("sandbox", { ...environment, PULSO_CHECKOUT_ORIGIN: "https://pulso.example.test/path" })).toThrow();
  });
});
