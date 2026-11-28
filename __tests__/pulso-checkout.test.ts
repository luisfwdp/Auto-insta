import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAsaasClient } from "../lib/billing/asaas-client";
import { createPulsoClient } from "../lib/billing/pulso-checkout";
import { parsePulsoNotification } from "../lib/billing/pulso-webhook";

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
const production = { ...environment, ASAAS_ENVIRONMENT: "production", PULSO_CHECKOUT_ENVIRONMENT: "production",
  NEXTAUTH_URL: "https://pingchatbr.app" };
const catalogInput = { ...input, planId: "pro-v1" as const };
const productionResult = { ...result, id: "30000000-0000-4000-8000-000000000003",
  paymentUrl: result.paymentUrl.replace("sandbox.asaas.com", "asaas.com") };

function brandedLink(overrides: Partial<{ product: string; plan: string; cents: number; id: string; expiration: number }> = {}) {
  const { product = "ping-chat", plan = catalogInput.planId, cents = catalogInput.amountCents,
    id = result.providerId, expiration = Math.floor(Date.now() / 1000) + 60 } = overrides;
  const proof = Buffer.from(JSON.stringify([product, plan, cents, id, expiration])).toString("base64url");
  return {
    checkoutUrl: `https://catalogo.pulsofinance.app/c/p1.${proof}.${"a".repeat(86)}`,
    expiresAt: new Date(expiration * 1000).toISOString(),
  };
}

describe("Pulso recurring checkout", () => {
  it("sends the immutable order to Pulso and returns the verified Asaas checkout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result, { status: 201 }));
    const { createHostedCheckout: createCheckout } = createPulsoClient("sandbox", environment, fetcher)!;
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
    const { createHostedCheckout: createCheckout } = createPulsoClient("sandbox", environment, fetcher)!;
    await expect(createCheckout(input)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("recognizes a definitive provider rejection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "asaas_rejected" }, { status: 422 }));
    const { createHostedCheckout: createCheckout } = createPulsoClient("sandbox", environment, fetcher)!;
    await expect(createCheckout(input)).rejects.toMatchObject({ code: "REJECTED" });
  });

  it("asks Pulso for a versioned plan and returns the matching branded link", async () => {
    const link = brandedLink();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(productionResult, { status: 201 }))
      .mockResolvedValueOnce(Response.json(link));
    const transport = createPulsoClient("production", production, fetcher)!;
    const gateway = createAsaasClient(production, fetcher, transport);
    await expect(gateway.createHostedCheckout(catalogInput)).resolves.toEqual({ id: result.providerId, url: link.checkoutUrl });
    const [[url, creation], [proofUrl, proofCall]] = fetcher.mock.calls;
    expect(String(url)).toBe("https://pulso.example.test/api/commerce/ping-chat");
    expect(JSON.parse(String(creation?.body))).toEqual({
      orderId: input.reference, plan: "pro-v1", nextDueDate: input.firstChargeDate,
      callback: {
        successUrl: `https://www.pingchatbr.app/settings/billing?checkout=${input.reference}&result=success`,
        cancelUrl: `https://www.pingchatbr.app/settings/billing?checkout=${input.reference}&result=canceled`,
        expiredUrl: `https://www.pingchatbr.app/settings/billing?checkout=${input.reference}&result=expired`,
      },
    });
    expect(String(proofUrl)).toBe(`https://pulso.example.test/api/charges/${productionResult.id}/checkout-link`);
    expect(proofCall).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
  });

  it.each([
    ["other checkout", () => brandedLink({ id: productionResult.id })],
    ["another product", () => brandedLink({ product: "criora" })],
    ["different plan", () => brandedLink({ plan: "essential-v1" })],
    ["different price", () => brandedLink({ cents: 1 })],
    ["expired proof", () => brandedLink({ expiration: 1_000 })],
    ["redirect origin", () => ({ ...brandedLink(), checkoutUrl: brandedLink().checkoutUrl.replace("pulsofinance.app/", "pulsofinance.app.example.test/") })],
  ])("retains the same Asaas checkout if the proof has %s", async (_name, issue) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(productionResult, { status: 201 }))
      .mockResolvedValueOnce(Response.json(issue()));
    const transport = createPulsoClient("production", production, fetcher)!;
    await expect(transport.createHostedCheckout(catalogInput)).resolves.toEqual({ id: result.providerId, url: productionResult.paymentUrl });
    expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET"]);
  });

  it("retains the proved checkout when the link lookup is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(productionResult, { status: 201 }))
      .mockRejectedValueOnce(new Error("link service unavailable"));
    const transport = createPulsoClient("production", production, fetcher)!;
    await expect(transport.createHostedCheckout(catalogInput)).resolves.toEqual({ id: result.providerId, url: productionResult.paymentUrl });
    expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET"]);
  });

  it("uses the versioned plan in Sandbox and opens only its Asaas checkout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...result, id: productionResult.id }, { status: 201 }));
    const transport = createPulsoClient("sandbox", environment, fetcher)!;
    await expect(transport.createHostedCheckout(catalogInput)).resolves.toEqual({ id: result.providerId, url: result.paymentUrl });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toBe("https://pulso.example.test/api/commerce/ping-chat");
  });

  it("refuses a divergent price before calling Pulso", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = createPulsoClient("production", production, fetcher)!;
    await expect(transport.createHostedCheckout({ ...catalogInput, amountCents: 1 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a new order uncertain when Asaas returns a URL for a different checkout", async () => {
    const other = { ...productionResult, paymentUrl: productionResult.paymentUrl.replace(result.providerId, input.reference) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(other, { status: 201 }));
    const transport = createPulsoClient("production", production, fetcher)!;
    await expect(transport.createHostedCheckout(catalogInput)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("requires consistent settings before checkout can be enabled", () => {
    expect(createPulsoClient("sandbox", {})).toBeUndefined();
    expect(() => createPulsoClient("production", environment)).toThrow();
    expect(() => createPulsoClient("sandbox", { ...environment, PULSO_CHECKOUT_ORIGIN: "https://pulso.example.test/path" })).toThrow();
  });

  it("reads and cancels through Pulso with no Asaas credentials or web callback configuration", async () => {
    const workerEnvironment = { ...environment, NEXTAUTH_URL: undefined };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "sub_monthly", customer: "cus_test", status: "ACTIVE", value: 149, cycle: "MONTHLY", deleted: false }))
      .mockResolvedValueOnce(Response.json({ id: "sub_monthly", deleted: true }));
    const transport = createPulsoClient("sandbox", workerEnvironment, fetcher);
    const gateway = createAsaasClient(workerEnvironment, fetcher, transport);
    await expect(gateway.getSubscription("sub_monthly")).resolves.toMatchObject({ id: "sub_monthly", valueCents: 14900 });
    await expect(gateway.cancelSubscription("sub_monthly")).resolves.toEqual({ id: "sub_monthly", deleted: true });
    for (const [url, request] of fetcher.mock.calls) {
      expect(String(url)).toBe("https://pulso.example.test/api/billing/subscriptions/sub_monthly");
      expect(new Headers(request?.headers).get("access_token")).toBeNull();
      expect(new Headers(request?.headers).get("x-pulso-environment")).toBe("sandbox");
    }
  });
});

describe("Pulso notifications", () => {
  it("authenticates the original body, date, app and idempotency key", () => {
    const secret = "test-secret-for-pulso-notifications";
    const now = Date.parse("2026-11-23T14:00:00Z");
    const timestamp = String(now / 1000);
    const payload = { id: result.providerId, app: "ping-chat", orderId: input.reference, event: "payment.confirmed", paymentId: "pay_test" };
    const raw = JSON.stringify(payload);
    const headers = new Headers({ "idempotency-key": payload.id, "x-pulso-timestamp": timestamp,
      "x-pulso-signature": `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}` });
    expect(parsePulsoNotification(headers, raw, secret, now)).toMatchObject({ event: "PAYMENT_CONFIRMED", paymentId: "pay_test", orderId: input.reference });
    expect(() => parsePulsoNotification(headers, raw + "\n", secret, now)).toThrow();
    expect(() => parsePulsoNotification(headers, raw, secret, now + 301_000)).toThrow();
    headers.set("idempotency-key", input.reference);
    expect(() => parsePulsoNotification(headers, raw, secret, now)).toThrow();
  });
});
