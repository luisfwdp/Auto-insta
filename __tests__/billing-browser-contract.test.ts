import { describe, expect, it, vi } from "vitest";
import {
  billingPlansSchema, billingStatusSchema, billingUsageSchema, checkoutSchema, cancellationSchema, savedBillingSchema,
  safeAsaasCheckoutUrl, billingRequest, createBrowserCheckout, createBrowserCancellation, pollBillingOperation,
  type PendingBillingRequest,
} from "@/lib/billing/browser-contract";

const requestId = "10000000-0000-4000-8000-000000000001", operationId = "20000000-0000-4000-8000-000000000002";
const quotas = { accounts: 1, members: 1, dms: 2000, publications: 120, storageBytes: 3000000000, transferBytes: 10000000000 };
const plan = billingPlansSchema.parse({ plans: [{ id: "essential-v1", name: "Essencial", amountCents: 7900, currency: "BRL", interval: "MONTHLY", trialDays: 3, cardRequiredForTrial: false, quotas }] }).plans[0];
const checkout = { id: operationId, status: "CREATING", planId: plan.id, amountCents: plan.amountCents, url: null };
const response = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });

describe("allowlisted browser billing DTOs", () => {
  it("handles disabled status without inventing access or dates", () => {
    expect(billingStatusSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(billingStatusSchema.safeParse({ enabled: true }).success).toBe(false);
  });
  it("strips provider data and never synthesizes private or missing counters as zero", () => {
    const privateUsage = { hasAccess: true, kind: "trial", periodStart: "2026-11-18T00:00:00Z", periodEnd: "2026-11-21T00:00:00Z", limits: quotas,
      metering: { storage: "NOT_REPORTED", transfer: "NOT_METERED" }, usageVisibility: "OWNER_ONLY", counters: null, providerToken: "secret" };
    expect(billingUsageSchema.parse(privateUsage)).toMatchObject({ counters: null, usageVisibility: "OWNER_ONLY" });
    expect(billingUsageSchema.parse(privateUsage)).not.toHaveProperty("providerToken");
    expect(billingUsageSchema.parse({ hasAccess: false, code: "BILLING_SUSPENDED", limits: null, counters: null }).counters).toBeNull();
    expect(billingUsageSchema.safeParse({ ...privateUsage, counters: { dms: { consumed: 0, reserved: 0, limit: 100 }, publications: { consumed: 0, reserved: 0, limit: 10 }, storage: null, transfer: null } }).success).toBe(false);
  });
  it("persists only scoped operation IDs and request IDs, without checkout URLs or tokens", () => {
    const saved = { checkout: { requestId, id: operationId }, cancellation: null };
    expect(savedBillingSchema.parse(saved)).toEqual(saved);
    expect(savedBillingSchema.safeParse({ ...saved, checkout: { ...saved.checkout, url: "https://asaas.com/pay", token: "secret" } }).success).toBe(false);
  });
  it.each(["https://asaas.com/checkout/path?opaque=1", "https://www.asaas.com/c/opaque", "https://sandbox.asaas.com/checkoutSession/show?id=fixture"])("preserves the server provider URL verbatim: %s", url => {
    expect(safeAsaasCheckoutUrl(url)).toBe(url);
    expect(checkoutSchema.safeParse({ ...checkout, status: "OPEN", url }).success).toBe(true);
  });
  it.each(["javascript:alert(1)", "http://asaas.com/path", "https://asaas.com.attacker.test/pay", "https://asaas.com@attacker.test/pay",
    "https://attacker@asaas.com/pay", "https://asaas.com:444/pay", "https://asaas.com/pay#fragment", "https://asaas.com/\\evil",
    "https://asaas.com/pay\n", "//asaas.com/pay", "https://sandbox.asaas.com.evil/pay"])("rejects unsafe hosted links: %s", url => {
    expect(safeAsaasCheckoutUrl(url)).toBeNull(); expect(checkoutSchema.safeParse({ ...checkout, status: "OPEN", url }).success).toBe(false);
  });
});

describe("explicit, durable browser mutations", () => {
  it("persists intent before its only POST and submits the exact agreed price/consent", async () => {
    const order: string[] = [], persisted: Array<PendingBillingRequest | null> = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => { order.push("POST"); expect(options?.method).toBe("POST");
      expect(JSON.parse(options!.body as string)).toEqual({ requestId, planId: "essential-v1", expectedAmountCents: 7900, acceptImmediateCharge: true });
      expect(options?.credentials).toBe("same-origin"); expect(options?.redirect).toBe("error"); return response(checkout, 202); });
    await createBrowserCheckout({ role: "OWNER", requestId, previous: null, consent: true, plan,
      persist: value => { order.push("save"); persisted.push(value); }, fetcher });
    expect(order).toEqual(["save", "POST", "save"]); expect(fetcher).toHaveBeenCalledOnce();
    expect(persisted).toEqual([{ requestId }, { requestId, id: operationId }]);
  });
  it.each(["ADMIN", "MEMBER"] as const)("never sends a mutation as %s", async role => {
    const fetcher = vi.fn(), persist = vi.fn();
    await expect(createBrowserCheckout({ role, requestId, previous: null, consent: true, plan, persist, fetcher })).rejects.toMatchObject({ status: 403 });
    await expect(createBrowserCancellation({ role, requestId, previous: null, consent: true, persist, fetcher })).rejects.toMatchObject({ status: 403 });
    expect(fetcher).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it("requires consent and refuses a second operation when an earlier outcome has no ID", async () => {
    const fetcher = vi.fn(), persist = vi.fn();
    for (const input of [{ consent: false, previous: null }, { consent: true, previous: { requestId } }])
      await expect(createBrowserCheckout({ role: "OWNER", requestId, plan, persist, fetcher, ...input })).rejects.toMatchObject({ status: 409 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never sends a financial request when browser intent storage fails", async () => {
    const fetcher = vi.fn();
    await expect(createBrowserCheckout({ role: "OWNER", requestId, previous: null, consent: true, plan, fetcher,
      persist: () => { throw new Error("storage unavailable"); } })).rejects.toThrow("storage unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps the original intent after an unknown POST response and never automatically re-POSTs", async () => {
    const persist = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: false, error: "CHECKOUT_OUTCOME_UNKNOWN" }, { status: 503 }));
    await expect(createBrowserCheckout({ role: "OWNER", requestId, previous: null, consent: true, plan, persist, fetcher })).rejects.toMatchObject({ code: "CHECKOUT_OUTCOME_UNKNOWN" });
    expect(persist).toHaveBeenCalledExactlyOnceWith({ requestId }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("allows only a fresh explicit action after a proven provider rejection, without automatic retries", async () => {
    const persist = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: false, error: "PROVIDER_REJECTED" }, { status: 422 }));
    await expect(createBrowserCheckout({ role: "OWNER", requestId, previous: null, consent: true, plan, persist, fetcher })).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
    expect(persist.mock.calls).toEqual([[{ requestId }], [null]]); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("starts cancellation with a separate explicit consent and no checkout/card payload", async () => {
    const persist = vi.fn(), fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      expect(JSON.parse(options!.body as string)).toEqual({ requestId }); return response({ id: operationId, status: "PENDING" }, 202);
    });
    await createBrowserCancellation({ role: "OWNER", requestId, previous: null, consent: true, persist, fetcher });
    expect(fetcher.mock.calls[0][0]).toBe("/api/billing/cancel");
    expect(persist).toHaveBeenLastCalledWith({ requestId, id: operationId });
  });
});

describe("bounded canonical polling", () => {
  it("uses at most four GETs for UNKNOWN and never creates a new request", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ ...checkout, status: "UNKNOWN" })), wait = vi.fn(async () => {}), update = vi.fn();
    await pollBillingOperation("checkout", operationId, checkoutSchema, update, { fetcher, wait });
    expect(fetcher).toHaveBeenCalledTimes(4); expect(wait).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetcher.mock.calls) { expect(url).toBe(`/api/billing/checkout?id=${operationId}`); expect(options?.method).toBe("GET"); expect(options?.body).toBeUndefined(); }
  });
  it("stops after OPEN and does not treat a payment link as subscription activation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ ...checkout, status: "OPEN", url: "https://asaas.com/checkout" })), update = vi.fn();
    const value = await pollBillingOperation("checkout", operationId, checkoutSchema, update, { fetcher, wait: async () => {} });
    expect(fetcher).toHaveBeenCalledOnce(); expect(value).not.toHaveProperty("hasAccess");
  });
  it("polls pending cancellation to completion without altering the paid period", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ id: operationId, status: "RETRY" })).mockResolvedValueOnce(response({ id: operationId, status: "PROCESSED" }));
    const update = vi.fn(); await pollBillingOperation("cancel", operationId, cancellationSchema, update, { fetcher, wait: async () => {} });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(update).toHaveBeenLastCalledWith({ id: operationId, status: "PROCESSED" });
    expect(update.mock.calls.some(([value]) => "paidThrough" in value)).toBe(false);
  });
  it("stops on forbidden lookup rather than creating a replacement operation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: false, error: "FORBIDDEN" }, { status: 403 }));
    await expect(pollBillingOperation("checkout", operationId, checkoutSchema, vi.fn(), { fetcher, wait: async () => {} })).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects unbounded poll budgets and non-billing endpoints without fetch", async () => {
    const fetcher = vi.fn();
    await expect(pollBillingOperation("checkout", operationId, checkoutSchema, vi.fn(), { attempts: 100, fetcher })).rejects.toMatchObject({ status: 400 });
    await expect(billingRequest("https://attacker.test/pay", checkoutSchema, { fetcher })).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
