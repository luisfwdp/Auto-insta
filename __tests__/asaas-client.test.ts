import { describe, expect, it, vi } from "vitest";
import { createAsaasClient, AsaasError } from "../lib/billing/asaas-client";
import { verifyAsaasWebhookToken } from "../lib/billing/asaas-webhook-auth";

const env = { ASAAS_ENVIRONMENT: "sandbox", ASAAS_API_KEY: "fake-api-credential-for-local-test-only", NEXTAUTH_URL: "https://app.example.test" };
const input = { reference: "a6bf6769-613c-445d-86ec-5732689971ca", name: "Pro", amountCents: 14900, firstChargeDate: "2027-01-31" };
const checkoutId = "131ca662-56c8-4479-b5b3-fd61a413fce7";

describe("Asaas hosted checkout boundary", () => {
  it("sends only an approved price snapshot to the fixed sandbox host; card details stay at Asaas", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: checkoutId, link: "https://evil.example/steal", customer: { cpfCnpj: "fake-private" } }));
    const client = createAsaasClient(env, fetcher);
    expect(await client.createHostedCheckout(input)).toEqual({ id: checkoutId, url: `https://sandbox.asaas.com/checkoutSession/show?id=${checkoutId}` });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api-sandbox.asaas.com/v3/checkouts");
    expect(init.redirect).toBe("error"); expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body)).toEqual({ billingTypes: ["CREDIT_CARD"], chargeTypes: ["RECURRENT"], minutesToExpire: 60, externalReference: input.reference,
      callback: { successUrl: `https://app.example.test/settings/billing?checkout=${input.reference}&result=success`, cancelUrl: `https://app.example.test/settings/billing?checkout=${input.reference}&result=canceled`, expiredUrl: `https://app.example.test/settings/billing?checkout=${input.reference}&result=expired` },
      items: [{ name: "Pro", quantity: 1, value: 149 }], subscription: { cycle: "MONTHLY", nextDueDate: "2027-01-31" } });
    expect(JSON.stringify(client)).not.toContain(env.ASAAS_API_KEY);
  });
  it.each([{}, { ...env, ASAAS_ENVIRONMENT: "live" }, { ...env, NEXTAUTH_URL: "http://public.example" }, { ...env, NEXTAUTH_URL: "https://user:password@app.example" }, { ...env, ASAAS_API_KEY: "fake\r\nleak" }])("fails closed for incomplete or unsafe configuration", config => {
    expect(() => createAsaasClient(config)).toThrow(AsaasError);
  });
  it("uses a distinct production host and refuses a loopback production URL", async () => {
    expect(() => createAsaasClient({ ...env, ASAAS_ENVIRONMENT: "production", NEXTAUTH_URL: "http://localhost:3000" })).toThrow(AsaasError);
    expect(() => createAsaasClient({ ...env, ASAAS_ENVIRONMENT: "production", NEXTAUTH_URL: "https://localhost:3000" })).toThrow(AsaasError);
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: checkoutId }));
    await createAsaasClient({ ...env, ASAAS_ENVIRONMENT: "production" }, fetcher).createHostedCheckout(input);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.asaas.com/v3/checkouts");
  });
  it.each([0, -1, 1.5, Number.NaN, 1_000_000_001])("rejects invalid cent values%s before calling the provider", async amountCents => {
    const fetcher = vi.fn(); await expect(createAsaasClient(env, fetcher).createHostedCheckout({ ...input, amountCents })).rejects.toMatchObject({ code: "INVALID_REQUEST" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects invalid calendar dates and client-supplied extra fields", async () => {
    const fetcher = vi.fn(); const client = createAsaasClient(env, fetcher);
    await expect(client.createHostedCheckout({ ...input, firstChargeDate: "2027-02-30" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(client.createHostedCheckout({ ...input, creditCard: { number: "fake-marker" } } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 401, 408, 409, 429, 500, 503])("redacts the provider error body at status%s and never retries a POST", async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ description: env.ASAAS_API_KEY }] }), { status }));
    let caught: unknown; try { await createAsaasClient(env, fetcher).createHostedCheckout(input); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: status >= 500 || status === 408 || status === 409 ? "UNKNOWN_OUTCOME" : "REJECTED", httpStatus: status });
    expect(String(caught)).not.toContain(env.ASAAS_API_KEY); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["timeout", "invalid response"])("keeps%s outcomes ambiguous instead of risking a duplicate checkout", async type => {
    const fetcher = type === "timeout" ? vi.fn().mockRejectedValue(new Error(env.ASAAS_API_KEY)) : vi.fn().mockResolvedValue(Response.json({ id: "invalid" }));
    await expect(createAsaasClient(env, fetcher).createHostedCheckout(input)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("bounds successful response bodies without retrying a possibly created checkout", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: checkoutId, extra: "x".repeat(65 * 1024) }));
    await expect(createAsaasClient(env, fetcher).createHostedCheckout(input)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("Asaas webhook authentication", () => {
  const token = "fake-distinct-webhook-secret-at-least-32-characters";
  it("requires the distinct configured token", () => {
    expect(verifyAsaasWebhookToken(new Headers({ "asaas-access-token": token }), { ...env, ASAAS_WEBHOOK_TOKEN: token })).toBe(true);
    expect(verifyAsaasWebhookToken(new Headers({ "asaas-access-token": "wrong" }), { ...env, ASAAS_WEBHOOK_TOKEN: token })).toBe(false);
    expect(verifyAsaasWebhookToken(new Headers(), { ...env, ASAAS_WEBHOOK_TOKEN: token })).toBe(false);
    expect(verifyAsaasWebhookToken(new Headers({ "asaas-access-token": token }), env)).toBe(false);
  });
  it("refuses reusing the API key as a webhook token", () => {
    expect(verifyAsaasWebhookToken(new Headers({ "asaas-access-token": env.ASAAS_API_KEY }), { ...env, ASAAS_WEBHOOK_TOKEN: env.ASAAS_API_KEY })).toBe(false);
  });
});

const payment = { id: "pay_1_a1B2c3D4e5F6g7", subscription: "sub_example_1", customer: "cus_example_1", checkoutSession: checkoutId,
  status: "CONFIRMED", value: 149.29, dueDate: "2027-01-31", deleted: false };
const subscription = { id: "sub_example_1", customer: "cus_example_1", checkoutSession: checkoutId, status: "ACTIVE", value: 149.29, cycle: "MONTHLY", deleted: false };
const page = (data: unknown[], options = {}) => ({ hasMore: false, totalCount: data.length, offset: 0, limit: 10, data, ...options });

describe("Asaas read-only reconciliation", () => {
  it("retrieves payment and subscription with fixed hosts, GET-only headers, bounded timeout and allowlisted DTOs", async () => {
    const privateFields = { cpfCnpj: "fake-document", email: "fake@example.test", creditCard: { creditCardToken: "fake-card-token" }, customerData: { name: "fake-private" } };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...payment, ...privateFields })).mockResolvedValueOnce(Response.json({ ...subscription, ...privateFields }));
    const client = createAsaasClient(env, fetcher);
    expect(await client.getPayment(payment.id)).toEqual({ id: payment.id, subscription: payment.subscription, customer: payment.customer, checkoutSession: checkoutId,
      status: "CONFIRMED", valueCents: 14929, dueDate: "2027-01-31", deleted: false });
    expect(await client.getSubscription(subscription.id)).toEqual({ id: subscription.id, customer: subscription.customer, checkoutSession: checkoutId,
      status: "ACTIVE", valueCents: 14929, cycle: "MONTHLY", deleted: false });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`https://api-sandbox.asaas.com/v3/payments/${payment.id}`, `https://api-sandbox.asaas.com/v3/subscriptions/${subscription.id}`]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).not.toContain(env.ASAAS_API_KEY); expect(init.method).toBe("GET"); expect(init.body).toBeUndefined();
      expect(init.headers).toEqual({ access_token: env.ASAAS_API_KEY, Accept: "application/json", "User-Agent": "CRIA-PING/1.0" });
      expect(init.redirect).toBe("error"); expect(init.cache).toBe("no-store"); expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it("returns one explicit page including hasMore, without following provider URLs or silently fetching additional pages", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...page([payment], { hasMore: true, totalCount: 21, offset: 10 }), next: "https://evil.example/steal" }));
    expect(await createAsaasClient(env, fetcher).listPaymentsByCheckout(checkoutId, { offset: 10 })).toMatchObject({ hasMore: true, totalCount: 21, offset: 10, limit: 10, data: [{ valueCents: 14929 }] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`https://api-sandbox.asaas.com/v3/payments?checkoutSession=${checkoutId}&offset=10&limit=10`);
  });
  it("supports explicit page limits and the production host", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(page(Array.from({ length: 20 }, () => ({ ...payment, description: "x".repeat(1700) })), { limit: 20 })));
    const result = await createAsaasClient({ ...env, ASAAS_ENVIRONMENT: "production" }, fetcher).listPaymentsByCheckout(checkoutId, { limit: 20 });
    expect(result.data).toHaveLength(20);
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.asaas.com/v3/payments?checkoutSession=${checkoutId}&offset=0&limit=20`);
  });
  it.each(["../payments", "pay_../x", "pay_x?access_token=leak", "pay_x#fragment", "pay_x%2Fsecret", "https://evil.example/x", "pay_x\r\nheader", "pay_", "pay_" + "x".repeat(129)])("rejects unsafe payment IDs before network access: %s", async id => {
    const fetcher = vi.fn(); await expect(createAsaasClient(env, fetcher).getPayment(id)).rejects.toMatchObject({ code: "INVALID_REQUEST" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects unsafe subscription and checkout IDs and pagination/query injection before network access", async () => {
    const fetcher = vi.fn(); const client = createAsaasClient(env, fetcher);
    await expect(client.getSubscription("sub_x/../../payments")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(client.listPaymentsByCheckout(`${checkoutId}&customer=other`)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    for (const options of [{ limit: 0 }, { limit: 21 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: NaN }, { offset: 2_147_483_648 }, { customer: "cus_other" }]) {
      await expect(client.listPaymentsByCheckout(checkoutId, options as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 429, 500, 503])("classifies GET HTTP%s without implying an uncertain mutation or exposing provider errors", async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response(env.ASAAS_API_KEY, { status }));
    let caught: unknown; try { await createAsaasClient(env, fetcher).getPayment(payment.id); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: status >= 500 || status === 429 ? "UNAVAILABLE" : "REJECTED", httpStatus: status });
    expect(String(caught)).not.toContain(env.ASAAS_API_KEY); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("classifies GET transport/redirect failures as unavailable without retrying", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(env.ASAAS_API_KEY));
    await expect(createAsaasClient(env, fetcher).getSubscription(subscription.id)).rejects.toMatchObject({ code: "UNAVAILABLE" }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    { ...payment, id: "pay_other" }, { ...payment, value: 149.291 }, { ...payment, value: -1 }, { ...payment, value: 1e16 },
    { ...payment, dueDate: "2027-02-30" }, { ...payment, status: "UNKNOWN_FUTURE_STATUS" }, { ...payment, deleted: undefined },
  ])("fails closed on invalid or mismatched payment state %#", async body => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body));
    await expect(createAsaasClient(env, fetcher).getPayment(payment.id)).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([{ ...subscription, id: "sub_other" }, { ...subscription, cycle: "DAILY" }, { ...subscription, status: "UNKNOWN" }, { ...subscription, value: 1.001 }])("fails closed on invalid or mismatched subscription state %#", async body => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body));
    await expect(createAsaasClient(env, fetcher).getSubscription(subscription.id)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("normalizes absent optional associations without inventing provider relationships", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...payment, subscription: undefined, checkoutSession: undefined, value: 0 }));
    expect(await createAsaasClient(env, fetcher).getPayment(payment.id)).toMatchObject({ subscription: null, checkoutSession: null, valueCents: 0 });
  });
  it.each([
    page([{ ...payment, checkoutSession: "131ca662-56c8-4479-b5b3-fd61a413fce8" }]), page([{ ...payment, checkoutSession: undefined }]),
    page([payment], { offset: 1 }), page([payment], { limit: 100 }), page(Array.from({ length: 11 }, () => payment)),
    page([], { hasMore: "false" }), page([], { totalCount: -1 }),
  ])("rejects untrustworthy or mismatched checkout pages %#", async body => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body));
    await expect(createAsaasClient(env, fetcher).listPaymentsByCheckout(checkoutId)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it.each(["oversized", "invalid JSON"])("bounds GET response processing and redacts %s responses", async kind => {
    const fetcher = vi.fn().mockResolvedValue(kind === "oversized" ? Response.json({ ...payment, extra: "x".repeat(65 * 1024) }) : new Response(env.ASAAS_API_KEY));
    await expect(createAsaasClient(env, fetcher).getPayment(payment.id)).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(fetcher).toHaveBeenCalledOnce();
  });
});
