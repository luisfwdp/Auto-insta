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

  it("accepts only signed card disputes and reversals with consistent evidence", () => {
    const secret = "test-secret-for-pulso-notifications";
    const occurredAt = "2026-11-23T14:00:00Z";
    const now = Date.parse(occurredAt);
    const timestamp = String(now / 1000);
    const dispute = { id: result.providerId, app: "ping-chat", orderId: input.reference,
      event: "payment.chargeback_requested", paymentId: "pay_test", status: "CHARGEBACK_REQUESTED",
      billingType: "CREDIT_CARD", occurredAt };
    const reversal = { ...dispute, id: "30000000-0000-4000-8000-000000000003", event: "payment.chargeback_reversed",
      status: "RECEIVED", disputeId: dispute.id };
    const parse = (value: Record<string, unknown>) => {
      const raw = JSON.stringify(value);
      return parsePulsoNotification(new Headers({
        "idempotency-key": String(value.id), "x-pulso-timestamp": timestamp,
        "x-pulso-signature": `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`,
      }), raw, secret, now);
    };
    expect(parse(dispute)).toEqual({ id: "pulso:" + dispute.id, orderId: input.reference,
      event: "PAYMENT_CHARGEBACK_REQUESTED", paymentId: "pay_test" });
    expect(parse(reversal)).toMatchObject({ event: "PAYMENT_CHARGEBACK_REVERSED" });
    expect(() => parse({ ...dispute, billingType: "PIX" })).toThrow();
    expect(() => parse({ ...reversal, disputeId: undefined })).toThrow();
    expect(() => parse({ ...reversal, status: "CHARGEBACK_REQUESTED" })).toThrow();
    expect(() => parse({ ...reversal, app: "other-product" })).toThrow();
  });
});
