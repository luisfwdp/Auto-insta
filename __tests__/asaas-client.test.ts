import { describe, expect, it, vi } from "vitest";
import { createAsaasClient, AsaasError } from "../lib/billing/asaas-client";
import { verifyAsaasWebhookToken } from "../lib/billing/asaas-webhook-auth";

const env = { ASAAS_ENVIRONMENT: "sandbox", ASAAS_API_KEY: "fake-api-credential-for-local-test-only", NEXTAUTH_URL: "https://app.example.test" };
const input = { reference: "a6bf6769-613c-445d-86ec-5732689971ca", name: "Pro", amountCents: 14900, firstChargeDate: "2027-01-31" };
const checkoutId = "131ca662-56c8-4479-b5b3-fd61a413fce7";

describe("Asaas hosted checkout boundary", () => {
  it("sends only an approved price snapshot to the fixed sandbox host; card details stay at Asaas", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: checkoutId, customer: { cpfCnpj: "fake-private" } }));
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


describe("Asaas returned checkout links", () => {
  it.each([
    ["production", `https://www.asaas.com/123/checkoutSession/show/${checkoutId}?source=api&tag=a%2Fb`],
    ["production", `https://asaas.com/checkoutSession/show?id=${checkoutId}`],
    ["production", `https://www.asaas.com:443/new-prefix/checkoutSession/show/${checkoutId}?key=a+b`],
    ["sandbox", `https://sandbox.asaas.com/checkoutSession/show/${checkoutId}`],
    ["sandbox", `https://sandbox.asaas.com/variable-prefix/checkoutSession/show/${checkoutId}?source=api`],
    ["sandbox", `https://sandbox.asaas.com?tag=a@b&id=${checkoutId}`],
  ] as const)("preserves the complete returned %s link instead of rebuilding its path", async (mode, link) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: checkoutId, link, customerData: { cpfCnpj: "fake-private" } }));
    expect(await createAsaasClient({ ...env, ASAAS_ENVIRONMENT: mode }, fetcher).createHostedCheckout(input)).toEqual({ id: checkoutId, url: link });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    "https://evil.example/steal", "https://sandbox.asaas.com.evil.example/path", "https://evil-sandbox.asaas.com/path",
    "https://asaas.com/path", "https://www.asaas.com/path", "https://www.sandbox.asaas.com/path", "https://api-sandbox.asaas.com/path",
    "http://sandbox.asaas.com/path", "javascript:alert(1)", "data:text/html,fake", "//sandbox.asaas.com/path", "/checkoutSession/show?id=fake",
    "https://user:password@sandbox.asaas.com/path", "https://@sandbox.asaas.com/path", "https://sandbox.asaas.com@evil.example/path",
    "https://sandbox.asaas.com:444/path", "https://sandbox.asaas.com/path#fragment", "https://sandbox.asaas.com/path#",
    " https://sandbox.asaas.com/path", "https://sandbox.asaas.com/path\n", "https://sandbox.asaas.com/path\\suffix",
    "https://sandbox.asaas.com/" + "a".repeat(2048), "", null, 123,
  ])("does not silently fall back or retry after an invalid returned link %#", async link => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: checkoutId, link }));
    await expect(createAsaasClient(env, fetcher).createHostedCheckout(input)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects sandbox links in production, and keeps the documented id-only fallback when link is absent", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: checkoutId, link: `https://sandbox.asaas.com/path/${checkoutId}` }))
      .mockResolvedValueOnce(Response.json({ id: checkoutId }));
    const client = createAsaasClient({ ...env, ASAAS_ENVIRONMENT: "production" }, fetcher);
    await expect(client.createHostedCheckout(input)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(await client.createHostedCheckout(input)).toEqual({ id: checkoutId, url: `https://asaas.com/checkoutSession/show?id=${checkoutId}` });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("Asaas subscription invoice pagination", () => {
  it("returns one bounded subscription page including recurring invoices without checkoutSession", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(page([{ ...payment, checkoutSession: null }], { offset: 10, hasMore: true, totalCount: 21 })));
    const result = await createAsaasClient(env, fetcher).listPaymentsBySubscription(subscription.id, { offset: 10 });
    expect(result).toMatchObject({ hasMore: true, totalCount: 21, offset: 10, limit: 10, data: [{ subscription: subscription.id, checkoutSession: null, valueCents: 14929 }] });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`https://api-sandbox.asaas.com/v3/payments?subscription=${subscription.id}&offset=10&limit=10`);
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", headers: { access_token: env.ASAAS_API_KEY } });
    expect(init.body).toBeUndefined(); expect(init.signal).toBeInstanceOf(AbortSignal); expect(url).not.toContain(env.ASAAS_API_KEY);
  });
  it("permits at most20 records, preserves production host and does not follow next links", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...page(Array.from({ length: 20 }, () => ({ ...payment, checkoutSession: null })), { limit: 20 }), next: "https://evil.example" }));
    const result = await createAsaasClient({ ...env, ASAAS_ENVIRONMENT: "production" }, fetcher).listPaymentsBySubscription(subscription.id, { limit: 20 });
    expect(result.data).toHaveLength(20); expect(result).not.toHaveProperty("next"); expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.asaas.com/v3/payments?subscription=${subscription.id}&offset=0&limit=20`);
  });
  it.each([page([{ ...payment, subscription: "sub_other" }]), page([{ ...payment, subscription: null }]), page([{ ...payment, subscription: undefined }]),
    page([payment], { offset: 1 }), page([payment], { limit: 20 }), page(Array.from({ length: 11 }, () => payment)),
    page(Array.from({ length: 21 }, () => payment), { limit: 21 }), page([payment], { hasMore: "false" })])("rejects mismatched or malformed subscription pages %#", async body => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body));
    await expect(createAsaasClient(env, fetcher).listPaymentsBySubscription(subscription.id)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects unsafe subscription IDs and pagination before fetching", async () => {
    const fetcher = vi.fn(); const client = createAsaasClient(env, fetcher);
    for (const id of ["sub_x/../other", "sub_x?customer=cus_other", "https://evil.example", "sub_x%2fsecret"]) {
      await expect(client.listPaymentsBySubscription(id)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    for (const options of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { offset: -1 }, { customer: "cus_other" }]) {
      await expect(client.listPaymentsBySubscription(subscription.id, options as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects a subscription page over64KiB without retry or exposing its payload", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(page([{ ...payment, extra: "x".repeat(65 * 1024) }])));
    await expect(createAsaasClient(env, fetcher).listPaymentsBySubscription(subscription.id)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("Asaas subscription cancellation transport", () => {
  it("requires matching id and deleted:true from the official DELETE endpoint, stripping all other fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: subscription.id, deleted: true, customerData: { cpfCnpj: "fake-private" }, creditCard: { token: "fake-card" } }));
    expect(await createAsaasClient(env, fetcher).cancelSubscription(subscription.id)).toEqual({ id: subscription.id, deleted: true });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`https://api-sandbox.asaas.com/v3/subscriptions/${subscription.id}`);
    expect(url).not.toContain(env.ASAAS_API_KEY); expect(init).toMatchObject({ method: "DELETE", redirect: "error", cache: "no-store", headers: { access_token: env.ASAAS_API_KEY, Accept: "application/json" } });
    expect(init.body).toBeUndefined(); expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("uses the production DELETE host without changing the resource path", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: subscription.id, deleted: true }));
    await createAsaasClient({ ...env, ASAAS_ENVIRONMENT: "production" }, fetcher).cancelSubscription(subscription.id);
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.asaas.com/v3/subscriptions/${subscription.id}`);
  });
  it.each([400, 401, 403, 404, 408, 409, 429, 500, 503])("does not retry DELETE HTTP%s and redacts errors", async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ description: env.ASAAS_API_KEY, cpfCnpj: "fake-private" }] }), { status }));
    let caught: unknown; try { await createAsaasClient(env, fetcher).cancelSubscription(subscription.id); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: status >= 500 || status === 408 || status === 409 ? "UNKNOWN_OUTCOME" : "REJECTED", httpStatus: status });
    expect(String(caught)).not.toContain(env.ASAAS_API_KEY); expect(JSON.stringify(caught)).not.toContain("fake-private"); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("treats transport failures as an unknown mutation outcome and does not retry", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(env.ASAAS_API_KEY));
    await expect(createAsaasClient(env, fetcher).cancelSubscription(subscription.id)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([{ id: "sub_other", deleted: true }, { id: subscription.id, deleted: false }, { id: subscription.id }, { deleted: true }, { id: subscription.id, deleted: "true" }])("does not claim successful cancellation for ambiguous confirmation %#", async body => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body));
    await expect(createAsaasClient(env, fetcher).cancelSubscription(subscription.id)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["oversized", "invalid JSON", "empty204"])("keeps %s DELETE confirmation ambiguous without retry", async kind => {
    const response = kind === "oversized" ? Response.json({ id: subscription.id, deleted: true, extra: "x".repeat(65 * 1024) })
      : kind === "empty204" ? new Response(null, { status: 204 }) : new Response(env.ASAAS_API_KEY);
    const fetcher = vi.fn().mockResolvedValue(response);
    await expect(createAsaasClient(env, fetcher).cancelSubscription(subscription.id)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects unsafe cancellation IDs before issuing a mutation", async () => {
    const fetcher = vi.fn(); const client = createAsaasClient(env, fetcher);
    for (const id of ["sub_x/../other", "sub_x?customer=other", "sub_x#fragment", "https://evil.example", "sub_", "sub_x\r\nheader"]) {
      await expect(client.cancelSubscription(id)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
