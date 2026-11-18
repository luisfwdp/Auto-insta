/** Route preconditions use server context only; no DB/provider is contacted. */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ enabled: true, configured: true,
  context: null as { workspaceId: string; userId: string; role: "OWNER" | "ADMIN" | "MEMBER" } | null,
  getContext: vi.fn(), checkout: vi.fn(), readCheckout: vi.fn(), cancel: vi.fn(), readCancel: vi.fn(), trial: vi.fn(), status: vi.fn(), overview: vi.fn(), usage: vi.fn(), db: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: new Proxy({}, { get() { state.db(); throw new Error("Unexpected DB access"); } }) }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: () => state.getContext(), canManageBilling: (role: string) => role === "OWNER" }));
vi.mock("@/lib/billing/config", async original => ({ ...await original<typeof import("../lib/billing/config")>(), hasBillingProviderScope: () => state.configured }));
vi.mock("@/lib/billing/trial", () => ({ isBillingEnabled: () => state.enabled, startCardFreeTrial: (...args: unknown[]) => state.trial(...args), getWorkspaceBillingStatus: (...args: unknown[]) => state.status(...args) }));
vi.mock("@/lib/billing/checkout", async original => ({ ...await original<typeof import("../lib/billing/checkout")>(), requestCheckout: (...args: unknown[]) => state.checkout(...args), readCheckout: (...args: unknown[]) => state.readCheckout(...args) }));
vi.mock("@/lib/billing/cancellation", () => ({ requestSubscriptionCancellation: (...args: unknown[]) => state.cancel(...args), readCancellation: (...args: unknown[]) => state.readCancel(...args) }));
vi.mock("@/lib/billing/overview", () => ({ readBillingOverview: (...args: unknown[]) => state.overview(...args) }));
vi.mock("@/lib/billing/commercial-overview", () => ({ readCommercialUsageOverview: (...args: unknown[]) => state.usage(...args) }));
import { POST as trialPOST } from "../app/api/billing/trial/route";
import { POST as checkoutPOST, GET as checkoutGET } from "../app/api/billing/checkout/route";
import { POST as cancelPOST, GET as cancelGET } from "../app/api/billing/cancel/route";
import { GET as statusGET } from "../app/api/billing/status/route";
import { GET as usageGET } from "../app/api/billing/usage/route";
const origin = "https://billing.example.test", id = "10000000-0000-4000-8000-000000000001";
const postBody = (name: string) => name === "checkout" ? { requestId: id, planId: "pro-v1", expectedAmountCents: 14900, acceptImmediateCharge: true } : { requestId: id };
function request(name: string, method: "POST" | "GET", pin?: string) {
  const headers = new Headers({ origin, "content-type": "application/json" }); if (pin !== undefined) headers.set("x-cria-workspace-id", pin);
  return new NextRequest(`${origin}/api/billing/${name}${method === "GET" && ["checkout", "cancel"].includes(name) ? `?id=${id}` : ""}`,
    { method, headers, ...(method === "POST" ? { body: JSON.stringify(postBody(name)) } : {}) });
}
const writes = [["trial", trialPOST], ["checkout", checkoutPOST], ["cancel", cancelPOST]] as const;
const reads = [["checkout", checkoutGET], ["cancel", cancelGET], ["status", statusGET], ["usage", usageGET]] as const;
const services = () => [state.checkout, state.readCheckout, state.cancel, state.readCancel, state.trial, state.status, state.overview, state.usage, state.db];
async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({ success: false, error: code });
  for (const call of services()) expect(call).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks(); state.enabled = true; state.configured = true; state.context = { workspaceId: "workspace-a", userId: "user-a", role: "OWNER" };
  state.getContext.mockReset().mockImplementation(async () => state.context);
  const checkout = { id, status: "OPEN", planId: "pro-v1", amountCents: 14900, url: "https://sandbox.asaas.com/fixture" };
  state.checkout.mockReset().mockResolvedValue(checkout); state.readCheckout.mockReset().mockResolvedValue(checkout);
  state.cancel.mockReset().mockResolvedValue({ id, status: "PENDING" }); state.readCancel.mockReset().mockResolvedValue({ id, status: "PENDING" });
  for (const call of [state.trial, state.status, state.overview, state.usage]) call.mockReset().mockResolvedValue({ hasAccess: true, status: "TRIALING" });
  vi.stubEnv("NEXTAUTH_URL", origin); vi.stubEnv("AUTH_URL", ""); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider access"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe.each(writes)("%s financial write workspace precondition", (name, POST) => {
  it.each([undefined, "", "workspace a", "workspace-a,workspace-a", "x".repeat(201)])("requires one well-formed browser workspace before body/core: %s", async pin => {
    const req = request(name, "POST", pin), read = vi.spyOn(req.body!, "getReader");
    await failure(await POST(req), 400, "WORKSPACE_CONTEXT_REQUIRED"); expect(read).not.toHaveBeenCalled();
  });
  it("rejects tab A's expected workspace after tab B selected another workspace", async () => {
    state.context!.workspaceId = "workspace-b"; const req = request(name, "POST", "workspace-a"), read = vi.spyOn(req.body!, "getReader");
    await failure(await POST(req), 409, "WORKSPACE_CHANGED"); expect(read).not.toHaveBeenCalled();
  });
  it.each(["ADMIN", "MEMBER"] as const)("preserves %s RBAC before workspace preconditions", async role => {
    state.context!.role = role; const response = await POST(request(name, "POST", "workspace-b"));
    expect(response.status).toBe(403); for (const call of services()) expect(call).not.toHaveBeenCalled();
  });
  it("captures the authenticated context once, so a later selection cannot redirect the effect", async () => {
    const req = request(name, "POST", "workspace-a"), originalReader = req.body!.getReader.bind(req.body!);
    vi.spyOn(req.body!, "getReader").mockImplementation(() => {
      state.context!.workspaceId = "workspace-b"; return originalReader();
    });
    const service = name === "trial" ? state.trial : name === "checkout" ? state.checkout : state.cancel;
    if (name === "trial") state.trial.mockImplementation(async workspaceId => { state.context!.workspaceId = "workspace-b"; expect(workspaceId).toBe("workspace-a"); return { hasAccess: true }; });
    expect((await POST(req)).status).toBe(name === "cancel" ? 202 : 200);
    expect(service.mock.calls[0][0]).toBe("workspace-a"); expect(state.getContext).toHaveBeenCalledOnce();
    expect(state.context!.workspaceId).toBe("workspace-b");
  });
});
describe.each(reads)("%s financial read workspace precondition", (name, GET) => {
  it("preserves legacy GET without a pin and accepts the matching pin", async () => {
    expect((await GET(request(name, "GET"))).status).toBe(200);
    expect((await GET(request(name, "GET", "workspace-a"))).status).toBe(200);
  });
  it("rejects an optional mismatched pin before financial reads", async () => { await failure(await GET(request(name, "GET", "workspace-b")), 409, "WORKSPACE_CHANGED"); });
  it("rejects a malformed present pin before financial reads", async () => { await failure(await GET(request(name, "GET", "workspace-a,workspace-b")), 400, "WORKSPACE_CONTEXT_REQUIRED"); });
});
it("preserves cancellation during commercial rollback but still enforces the workspace pin", async () => {
  state.enabled = false;
  await failure(await cancelPOST(request("cancel", "POST", "workspace-b")), 409, "WORKSPACE_CHANGED");
  expect((await cancelPOST(request("cancel", "POST", "workspace-a"))).status).toBe(202);
});
it.each(["status", "usage"])("keeps %s readable by workspace members with a matching pin", async name => {
  state.context!.role = "MEMBER"; const response = await (name === "status" ? statusGET : usageGET)(request(name, "GET", "workspace-a")); expect(response.status).toBe(200);
});
