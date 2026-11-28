vi.mock("@/lib/api/request-rate-limit", () => ({ consumeRequestLimit: vi.fn(async () => ({ allowed: true, retryAfter: 60 })) }));
/** Route boundary tests. Services/provider are mocked; no real payment proof. */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: true, configured: true,
  context: null as { workspaceId: string; role: "OWNER" | "ADMIN" | "MEMBER" } | null,
  getContext: vi.fn(), create: vi.fn(), readCheckout: vi.fn(), cancel: vi.fn(), readCancel: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: new Proxy({}, { get() { throw new Error("Unexpected database access"); } }) }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: (...args: unknown[]) => state.getContext(...args), canManageBilling: (role: string) => role === "OWNER" }));
vi.mock("@/lib/billing/trial", () => ({ isBillingEnabled: () => state.enabled, CARD_FREE_TRIAL_DAYS: 3 }));
vi.mock("@/lib/billing/config", async importOriginal => ({ ...await importOriginal<typeof import("../lib/billing/config")>(), hasBillingProviderScope: () => state.configured }));
vi.mock("@/lib/billing/checkout", async importOriginal => ({ ...await importOriginal<typeof import("../lib/billing/checkout")>(), requestCheckout: (...args: unknown[]) => state.create(...args), readCheckout: (...args: unknown[]) => state.readCheckout(...args) }));
vi.mock("@/lib/billing/cancellation", () => ({ requestSubscriptionCancellation: (...args: unknown[]) => state.cancel(...args), readCancellation: (...args: unknown[]) => state.readCancel(...args) }));

import { POST as checkoutPOST, GET as checkoutGET } from "../app/api/billing/checkout/route";
import { POST as cancelPOST, GET as cancelGET } from "../app/api/billing/cancel/route";
import { GET as plansGET } from "../app/api/billing/plans/route";
import { BillingError } from "../lib/billing/config";

const origin = "https://app.example.test";
const id = "96fcdd20-d846-4d9a-9489-941df65f696e";
const otherId = "c8d5f1f8-e0de-43e9-98b5-94633348977c";
const checkout = { id, status: "OPEN", planId: "pro-v1", amountCents: 14900, url: "https://sandbox.asaas.com/checkoutSession/show?id=fake" };
const checkoutBody = { requestId: id, planId: "pro-v1", expectedAmountCents: 14900, acceptImmediateCharge: true };
const routes = [["checkout", checkoutPOST, checkoutGET], ["cancel", cancelPOST, cancelGET]] as const;
const bodyFor = (kind: string) => kind === "checkout" ? checkoutBody : { requestId: id };
function post(kind: string, body: unknown = bodyFor(kind), headers: Record<string, string> = {}) {
  return new NextRequest(`${origin}/api/billing/${kind}`, { method: "POST", headers: { Origin: origin, "x-cria-workspace-id": "workspace-a", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function get(kind: string, query = `id=${id}`) { return new NextRequest(`${origin}/api/billing/${kind}?${query}`); }
async function expectFailure(response: Response, status: number, error: string) {
  expect(response.status).toBe(status); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ success: false, error });
}

beforeEach(() => {
  state.enabled = true; state.configured = true; state.context = { workspaceId: "workspace-a", role: "OWNER" };
  state.getContext.mockReset().mockImplementation(async () => state.context);
  state.create.mockReset().mockResolvedValue(checkout); state.readCheckout.mockReset().mockResolvedValue(checkout);
  state.cancel.mockReset().mockResolvedValue({ id, status: "PENDING" }); state.readCancel.mockReset().mockResolvedValue({ id, status: "PENDING" });
  vi.stubEnv("NEXTAUTH_URL", origin); vi.stubEnv("AUTH_URL", "");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network access"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("passes only the cookie scoped to the owner's chosen plan into checkout creation", async () => {
  vi.stubEnv("PULSO_CHECKOUT_ENABLED", "true");
  const cookie = `pulso-offer-pro-v1=${otherId}`;
  expect((await checkoutPOST(post("checkout", checkoutBody, { cookie }))).status).toBe(200);
  expect(state.create).toHaveBeenCalledExactlyOnceWith("workspace-a", checkoutBody, undefined, { affiliateCode: undefined, offerReference: otherId });
  state.create.mockClear();
  expect((await checkoutPOST(post("checkout", { ...checkoutBody, offerReference: otherId }, { cookie }))).status).toBe(400);
  expect(state.create).not.toHaveBeenCalled();
});

describe.each(routes)("billing %s route boundaries", (kind, POST, GET) => {
  it.each([undefined, "https://evil.example.test", "null"])("rejects untrusted/missing browser Origin %s before authentication or body parsing", async value => {
    const request = post(kind);
    if (value === undefined) request.headers.delete("Origin"); else request.headers.set("Origin", value);
    const read = vi.spyOn(request.body!, "getReader");
    await expectFailure(await POST(request), 403, "FORBIDDEN");
    expect(state.getContext).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled();
  });
  it("requires a session for reads and writes before reading the body", async () => {
    state.context = null;
    const request = post(kind), read = vi.spyOn(request.body!, "getReader");
    await expectFailure(await POST(request), 401, "UNAUTHORIZED");
    await expectFailure(await GET(get(kind)), 401, "UNAUTHORIZED");
    expect(read).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled();
  });
  it.each(["ADMIN", "MEMBER"] as const)("does not let %s inspect or mutate owner billing", async role => {
    state.context = { workspaceId: "workspace-a", role };
    await expectFailure(await POST(post(kind)), 403, "FORBIDDEN");
    await expectFailure(await GET(get(kind)), 403, "FORBIDDEN");
    expect(state.create).not.toHaveBeenCalled(); expect(state.readCheckout).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled(); expect(state.readCancel).not.toHaveBeenCalled();
  });
  it("keeps a self-hosted deployment without billing configuration untouched", async () => {
    state.enabled = false; state.configured = false;
    await expectFailure(await POST(post(kind)), 404, "BILLING_DISABLED");
    await expectFailure(await GET(get(kind)), 404, "BILLING_DISABLED");
    expect(state.create).not.toHaveBeenCalled(); expect(state.readCheckout).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled(); expect(state.readCancel).not.toHaveBeenCalled();
  });
  it("rejects client tenant/provider identifiers instead of forwarding them", async () => {
    await expectFailure(await POST(post(kind, { ...bodyFor(kind), workspaceId: "workspace-b", providerSubscriptionId: "sub_other" })), 400, "INVALID_REQUEST");
    expect(state.create).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled();
  });
  it("bounds actual streamed bytes before JSON parsing even with a false Content-Length", async () => {
    const chunks = [new TextEncoder().encode("{"), new TextEncoder().encode("é".repeat(2048))];
    const request = new NextRequest(`${origin}/api/billing/${kind}`, { method: "POST", headers: { Origin: origin, "x-cria-workspace-id": "workspace-a", "Content-Length": "1" }, body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) });
    await expectFailure(await POST(request), 413, "BODY_TOO_LARGE");
    expect(state.create).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled();
  });
  it("rejects declared oversized input before opening its stream", async () => {
    const request = post(kind, bodyFor(kind), { "Content-Length": "4097" }), read = vi.spyOn(request.body!, "getReader");
    await expectFailure(await POST(request), 413, "BODY_TOO_LARGE"); expect(read).not.toHaveBeenCalled();
  });
  it("accepts a valid request at the exact 4KiB boundary", async () => {
    const body = JSON.stringify(bodyFor(kind));
    const request = new NextRequest(`${origin}/api/billing/${kind}`, { method: "POST", headers: { Origin: origin, "x-cria-workspace-id": "workspace-a" }, body: body.padEnd(4096, " ") });
    expect((await POST(request)).status).toBe(kind === "checkout" ? 200 : 202);
  });
  it.each(["{", "null", "[]"])("rejects malformed or structurally invalid JSON %s", async body => {
    const request = new NextRequest(`${origin}/api/billing/${kind}`, { method: "POST", headers: { Origin: origin, "x-cria-workspace-id": "workspace-a" }, body });
    await expectFailure(await POST(request), 400, "INVALID_REQUEST");
    expect(state.create).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled();
  });
  it.each(["", "id=bad", `id=${id}&id=${otherId}`, `id=${id}&workspaceId=workspace-b`])("rejects an absent, ambiguous or injected GET id: %s", async query => {
    await expectFailure(await GET(get(kind, query)), 400, "INVALID_REQUEST");
    expect(state.readCheckout).not.toHaveBeenCalled(); expect(state.readCancel).not.toHaveBeenCalled();
  });
  it("reads only through the active server workspace and lets the scoped service decide ownership", async () => {
    const response = await GET(get(kind, `id=${otherId}`)); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(kind === "checkout" ? state.readCheckout : state.readCancel).toHaveBeenCalledExactlyOnceWith("workspace-a", otherId);
  });
  it("redacts service/provider/database failures and preserves no-store on 503", async () => {
    const error = new Error("fake-private-api-key fake-customer-document");
    (kind === "checkout" ? state.create : state.cancel).mockRejectedValue(error);
    (kind === "checkout" ? state.readCheckout : state.readCancel).mockRejectedValue(error);
    await expectFailure(await POST(post(kind)), 503, "BILLING_UNAVAILABLE");
    await expectFailure(await GET(get(kind)), 503, "BILLING_UNAVAILABLE");
  });
  it("passes only fixed typed billing error codes and their status", async () => {
    (kind === "checkout" ? state.create : state.cancel).mockRejectedValue(new BillingError("RATE_LIMITED", 429));
    await expectFailure(await POST(post(kind)), 429, "RATE_LIMITED");
  });
});

describe("checkout consent, result and versioned price boundary", () => {
  it("passes only the validated request and the server workspace; excludes internal DTO extras", async () => {
    state.create.mockResolvedValue({ ...checkout, providerCustomerId: "cus_private", apiKey: "fake-private" });
    const response = await checkoutPOST(post("checkout"));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: checkout });
    expect(state.create).toHaveBeenCalledExactlyOnceWith("workspace-a", checkoutBody);
  });
  it.each(["CREATING", "UNKNOWN"])("returns202 for %s instead of implying a ready or paid checkout", async status => {
    state.create.mockResolvedValue({ ...checkout, status, url: null });
    expect((await checkoutPOST(post("checkout"))).status).toBe(202);
  });
  it.each([
    { ...checkoutBody, acceptImmediateCharge: false }, { requestId: id, planId: "pro-v1", expectedAmountCents: 14900 },
    { requestId: id, planId: "pro-v1", acceptImmediateCharge: true }, { ...checkoutBody, expectedAmountCents: 149.5 },
    { ...checkoutBody, planId: "client-unlimited" }, { ...checkoutBody, requestId: "bad" }, { ...checkoutBody, amountCents: 1 },
  ])("rejects missing consent/acknowledgment, unknown plans or caller price fields %#", async body => {
    await expectFailure(await checkoutPOST(post("checkout", body)), 400, "INVALID_REQUEST"); expect(state.create).not.toHaveBeenCalled();
  });
  it("returns an offer-change conflict from the server without echoing a price supplied by the client", async () => {
    state.create.mockRejectedValue(new BillingError("OFFER_CHANGED"));
    await expectFailure(await checkoutPOST(post("checkout", { ...checkoutBody, expectedAmountCents: 2900 })), 409, "OFFER_CHANGED");
  });
  it("keeps checkout disabled during rollback even when a provider scope exists", async () => {
    state.enabled = false; state.configured = true;
    await expectFailure(await checkoutPOST(post("checkout")), 404, "BILLING_DISABLED");
  });
});

describe("durable cancellation during rollback", () => {
  it("continues accepting and reading cancellation with commercial checkout disabled", async () => {
    state.enabled = false; state.configured = true;
    state.cancel.mockResolvedValue({ id, status: "PENDING", providerSubscriptionId: "sub_private", token: "fake-private" });
    const response = await cancelPOST(post("cancel"));
    expect(response.status).toBe(202); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: { id, status: "PENDING" } });
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith("workspace-a", id);
    expect((await cancelGET(get("cancel"))).status).toBe(200);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("rejects client-selected subscriptions and extra fields", async () => {
    await expectFailure(await cancelPOST(post("cancel", { requestId: id, subscriptionId: "sub_other" })), 400, "INVALID_REQUEST");
    expect(state.cancel).not.toHaveBeenCalled();
  });
});

describe("public billing plan catalog", () => {
  it("returns only versioned offers and public quotas, without authentication, DB or provider calls", async () => {
    state.context = null;
    const response = await plansGET(); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.data.plans.map((plan: { id: string; amountCents: number }) => [plan.id, plan.amountCents])).toEqual([["essential-v1", 7900], ["pro-v1", 14900], ["agency-v1", 29900]]);
    for (const plan of body.data.plans) {
      expect(Object.keys(plan).sort()).toEqual(["id", "name", "amountCents", "currency", "interval", "trialDays", "cardRequiredForTrial", "quotas"].sort());
      expect(plan).toMatchObject({ currency: "BRL", interval: "MONTHLY", trialDays: 3, cardRequiredForTrial: false });
      expect(Object.keys(plan.quotas).sort()).toEqual(["accounts", "members", "dms", "publications", "storageBytes", "transferBytes"].sort());
    }
    expect(state.getContext).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("does not announce commercial offers while disabled", async () => {
    state.enabled = false;
    await expectFailure(await plansGET(), 404, "BILLING_DISABLED");
    expect(state.getContext).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
