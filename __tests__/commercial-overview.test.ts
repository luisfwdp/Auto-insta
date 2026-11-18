import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ enabled: true, context: null as { workspaceId: string; role: string } | null,
  contextCall: vi.fn(), loader: vi.fn(), buckets: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/billing/trial", () => ({ isBillingEnabled: () => state.enabled }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: () => state.contextCall(), canManageBilling: () => false }));
vi.mock("@/lib/billing/commercial-access", () => ({ loadCommercialEntitlement: (...args: unknown[]) => state.loader(...args) }));
vi.mock("@/lib/db/client", () => ({ prisma: { $transaction: (...args: unknown[]) => state.transaction(...args) } }));
import { readCommercialOverview } from "../lib/billing/commercial-overview";
import { GET } from "../app/api/billing/usage/route";
import { BillingError } from "../lib/billing/config";
const limits = { accounts: 1, members: 1, dms: 100, publications: 10, storageBytes: 1_000_000_000, transferBytes: 500_000_000 };
const active = { status: "trial", subjectKind: "OWNER_TRIAL", subjectId: "private-owner-id", periodStart: new Date("2026-11-17T00:00:00Z"), periodEnd: new Date("2026-11-20T00:00:00Z"), limits };
beforeEach(() => {
  state.enabled = true; state.context = { workspaceId: "server-workspace", role: "OWNER" };
  state.contextCall.mockReset().mockImplementation(async () => state.context);
  state.transaction.mockReset().mockImplementation(async callback => callback({ commercialUsageBucket: { findMany: state.buckets } }));
  state.loader.mockReset().mockResolvedValue(active); state.buckets.mockReset().mockResolvedValue([]);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No real provider access"));
});
afterEach(() => vi.restoreAllMocks());
describe("commercial overview read boundaries", () => {
  it("returns404 before auth or DB when billing is off", async () => {
    state.enabled = false;
    await expect(readCommercialOverview("ignored")).rejects.toMatchObject({ code: "BILLING_DISABLED", httpStatus: 404 });
    const response = await GET(); expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.contextCall).not.toHaveBeenCalled(); expect(state.transaction).not.toHaveBeenCalled();
  });
  it("requires authenticated workspace context", async () => {
    state.context = null; const response = await GET(); expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: "UNAUTHORIZED" });
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(state.transaction).not.toHaveBeenCalled();
  });
  it.each(["OWNER", "ADMIN", "MEMBER"])("allows %s to read only the server workspace", async role => {
    state.context = { workspaceId: "server-workspace", role };
    const response = await GET(); expect(response.status).toBe(200);
    expect(state.loader).toHaveBeenCalledWith(expect.anything(), "server-workspace", expect.any(Date));
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("returns an allowlisted DTO with explicit unreported byte counters", async () => {
    state.buckets.mockResolvedValue([{ resource: "DM", consumed: BigInt("3"), reserved: BigInt("2") }]);
    const result = await readCommercialOverview("server-workspace");
    expect(result).toEqual({ hasAccess: true, kind: "trial", periodStart: active.periodStart.toISOString(), periodEnd: active.periodEnd.toISOString(), limits,
      counters: { dms: { consumed: 3, reserved: 2, limit: 100 }, publications: { consumed: 0, reserved: 0, limit: 10 }, storage: null, transfer: null }, metering: { storage: "NOT_REPORTED", transfer: "NOT_METERED" } });
    expect(JSON.stringify(result)).not.toContain("private-owner-id");
    expect(state.buckets).toHaveBeenCalledWith({ where: { subjectKind: "OWNER_TRIAL", subjectId: active.subjectId, scopeKey: "owner-trial-v1", periodStart: active.periodStart, periodEnd: active.periodEnd, resource: { in: ["DM", "PUBLICATION"] } }, select: { resource: true, consumed: true, reserved: true } });
  });
  it.each([null, { status: "denied", code: "TRIAL_NOT_ACTIVE" }])("denied entitlement reveals no counters or financial details: %j", async access => {
    state.loader.mockResolvedValue(access); const result = await readCommercialOverview("server-workspace");
    expect(result).toEqual({ hasAccess: false, code: access?.code ?? "BILLING_NOT_STARTED", limits: null, counters: null }); expect(state.buckets).not.toHaveBeenCalled();
  });
  it.each([BigInt(Number.MAX_SAFE_INTEGER) + BigInt("1"), -BigInt("1")])("fails closed for an unsafe stored counter %s", async consumed => {
    state.buckets.mockResolvedValue([{ resource: "DM", consumed, reserved: BigInt("0") }]);
    const response = await GET(); expect(response.status).toBe(503); expect(await response.json()).toEqual({ success: false, error: "BILLING_UNAVAILABLE" });
  });
  it.each([new Error("secret-token-and-prisma-details"), new BillingError("bad secret", 500)])("redacts unexpected service errors", async error => {
    state.loader.mockRejectedValue(error); const response = await GET(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: "BILLING_UNAVAILABLE" }); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
