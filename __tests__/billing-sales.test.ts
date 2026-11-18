/** Sales-circuit contract; all persistence/provider boundaries are mocked. */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ transaction: vi.fn(), findCheckout: vi.fn(), findBilling: vi.fn(), countCommands: vi.fn(), cancel: vi.fn(), decrypt: vi.fn(), encrypt: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { $transaction: (...args: unknown[]) => state.transaction(...args), billingCheckout: { findFirst: (...args: unknown[]) => state.findCheckout(...args) }, workspaceBilling: { findUnique: (...args: unknown[]) => state.findBilling(...args) }, billingCommand: { count: (...args: unknown[]) => state.countCommands(...args) } } }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: async () => ({ workspaceId: "workspace-a", role: "OWNER", userId: "owner-a" }), canManageBilling: (role: string) => role === "OWNER" }));
vi.mock("@/lib/meta/oauth", () => ({ encryptToken: (...args: unknown[]) => state.encrypt(...args), decryptToken: (...args: unknown[]) => state.decrypt(...args) }));
vi.mock("@/lib/billing/cancellation", () => ({ requestSubscriptionCancellation: (...args: unknown[]) => state.cancel(...args), readCancellation: vi.fn() }));

import { isBillingSalesEnabled } from "../lib/billing/sales";
import { requestCheckout, readCheckout, type CheckoutRequest } from "../lib/billing/checkout";
import { GET as plansGET } from "../app/api/billing/plans/route";
import { GET as statusGET } from "../app/api/billing/status/route";
import { POST as cancelPOST } from "../app/api/billing/cancel/route";
import { BillingError } from "../lib/billing/config";
import type { createAsaasClient } from "../lib/billing/asaas-client";

type Gateway = ReturnType<typeof createAsaasClient>;
const id = "10000000-0000-4000-8000-000000000001", scope = "20000000-0000-4000-8000-000000000002";
const hostedUrl = "https://sandbox.asaas.com/checkoutSession/show?id=fake-owner-link";
const input: CheckoutRequest = { requestId: id, planId: "pro-v1", expectedAmountCents: 14900, acceptImmediateCharge: true };
function gateway() {
  return { createHostedCheckout: vi.fn<Gateway["createHostedCheckout"]>(), getPayment: vi.fn<Gateway["getPayment"]>(),
    getSubscription: vi.fn<Gateway["getSubscription"]>(), listPaymentsByCheckout: vi.fn<Gateway["listPaymentsByCheckout"]>(),
    listPaymentsBySubscription: vi.fn<Gateway["listPaymentsBySubscription"]>(), cancelSubscription: vi.fn<Gateway["cancelSubscription"]>() } satisfies Gateway;
}

beforeEach(() => {
  vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("BILLING_SALES_ENABLED", undefined);
  vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox"); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", scope); vi.stubEnv("NEXTAUTH_URL", "https://app.example.test");
  vi.stubEnv("VERCEL_ENV", "test"); vi.stubEnv("FLY_APP_NAME", "local-sales-test");
  state.transaction.mockReset().mockRejectedValue(new BillingError("TEST_DATABASE_BOUNDARY", 503));
  state.findCheckout.mockReset().mockResolvedValue({ id, workspaceId: "workspace-a", status: "OPEN", planId: "pro-v1", amountCents: 14900, checkoutUrlCiphertext: "fake-ciphertext", providerCheckoutId: "private-provider-id" });
  const now = Date.now();
  state.findBilling.mockReset().mockResolvedValue({ status: "ACTIVE", trialStartedAt: new Date(now - 10 * 86400_000), trialEndsAt: new Date(now - 7 * 86400_000), paidThrough: new Date(now + 86400_000), planId: "pro-v1",
    currentSubscription: { id, workspaceId: "workspace-a", environment: "sandbox", accountScope: scope, renewalStatus: "ACTIVE" } });
  state.countCommands.mockReset().mockResolvedValue(0);
  state.cancel.mockReset().mockResolvedValue({ id, status: "PENDING" }); state.encrypt.mockReset().mockReturnValue("fake-ciphertext"); state.decrypt.mockReset().mockReturnValue(hostedUrl);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Real provider HTTP is forbidden"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("commercial and new-sales environment matrix", () => {
  it.each([
    [undefined, undefined, false], [undefined, "true", false], ["false", "true", false], [" FALSE ", undefined, false], ["1", "true", false], ["", "true", false],
    ["true", undefined, true], [" TRUE ", "true", true], [" true ", " TrUe ", true],
    ["true", "false", false], ["true", " FALSE ", false], ["true", "", false], ["true", "  ", false], ["true", "1", false], ["true", "yes", false], ["true", "invalid", false],
  ])("commercial=%s sales=%s allows sales=%s", (commercial, sales, expected) => {
    vi.stubEnv("BILLING_ENABLED", commercial); vi.stubEnv("BILLING_SALES_ENABLED", sales);
    expect(isBillingSalesEnabled()).toBe(expected);
  });
  it("reads the current circuit value instead of caching an earlier enabled state", () => {
    expect(isBillingSalesEnabled()).toBe(true);
    vi.stubEnv("BILLING_SALES_ENABLED", "false"); expect(isBillingSalesEnabled()).toBe(false);
    vi.stubEnv("BILLING_SALES_ENABLED", "true"); expect(isBillingSalesEnabled()).toBe(true);
  });
});

describe("new sales are isolated from existing commercial access", () => {
  it.each(["false", " FALSE ", "", "invalid"])("rejects checkout before configuration, DB or provider work with sales=%s", async sales => {
    vi.stubEnv("BILLING_SALES_ENABLED", sales); vi.stubEnv("ASAAS_ACCOUNT_SCOPE", undefined); vi.stubEnv("NEXTAUTH_URL", undefined); vi.stubEnv("AUTH_URL", undefined);
    const provider = gateway();
    await expect(requestCheckout("workspace-a", input, provider)).rejects.toMatchObject({ code: "BILLING_SALES_DISABLED", httpStatus: 503 });
    expect(state.transaction).not.toHaveBeenCalled(); expect(state.encrypt).not.toHaveBeenCalled(); expect(provider.createHostedCheckout).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, "true"])("preserves the existing commercial path with sales=%s", async sales => {
    vi.stubEnv("BILLING_SALES_ENABLED", sales); const provider = gateway();
    await expect(requestCheckout("workspace-a", input, provider)).rejects.toMatchObject({ code: "TEST_DATABASE_BOUNDARY" });
    expect(state.transaction).toHaveBeenCalledOnce(); expect(state.encrypt).toHaveBeenCalledWith("billing-readiness"); expect(provider.createHostedCheckout).not.toHaveBeenCalled();
  });
  it("retains the legacy disabled-mode error even if sales is explicitly true", async () => {
    vi.stubEnv("BILLING_ENABLED", "false"); vi.stubEnv("BILLING_SALES_ENABLED", "true"); const provider = gateway();
    await expect(requestCheckout("workspace-a", input, provider)).rejects.toMatchObject({ code: "BILLING_DISABLED", httpStatus: 404 });
    expect(state.transaction).not.toHaveBeenCalled(); expect(provider.createHostedCheckout).not.toHaveBeenCalled();
  });
  it("still reads a scoped existing checkout while sales are paused", async () => {
    vi.stubEnv("BILLING_SALES_ENABLED", "false");
    expect(await readCheckout("workspace-a", id)).toEqual({ id, status: "OPEN", planId: "pro-v1", amountCents: 14900, url: hostedUrl });
    expect(state.findCheckout).toHaveBeenCalledExactlyOnceWith({ where: { id, workspaceId: "workspace-a", environment: "sandbox", accountScope: scope } });
    expect(state.transaction).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("preserves paid status and the cancellation route while sales are paused", async () => {
    vi.stubEnv("BILLING_SALES_ENABLED", "false");
    const status = await statusGET(); expect(status.status).toBe(200); expect((await status.json()).data).toMatchObject({ enabled: true, status: "ACTIVE", hasAccess: true, planId: "pro-v1" });
    const canceled = await cancelPOST(new NextRequest("https://app.example.test/api/billing/cancel", { method: "POST", headers: { Origin: "https://app.example.test" }, body: JSON.stringify({ requestId: id }) }));
    expect(canceled.status).toBe(202); expect(await canceled.json()).toEqual({ success: true, data: { id, status: "PENDING" } });
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith("workspace-a", id); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("hides offers during a sales pause and restores them when sales reopen", async () => {
    vi.stubEnv("BILLING_SALES_ENABLED", "false");
    const closed = await plansGET(); expect(closed.status).toBe(404); expect(closed.headers.get("Cache-Control")).toBe("no-store");
    expect(await closed.json()).toEqual({ success: false, error: "BILLING_SALES_DISABLED" });
    vi.stubEnv("BILLING_SALES_ENABLED", "true");
    const opened = await plansGET(); expect(opened.status).toBe(200); expect((await opened.json()).data.plans).toHaveLength(3);
    expect(state.transaction).not.toHaveBeenCalled(); expect(state.findBilling).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("does not publish offers in legacy mode regardless of the sales flag", async () => {
    vi.stubEnv("BILLING_ENABLED", "false"); vi.stubEnv("BILLING_SALES_ENABLED", "true");
    const response = await plansGET(); expect(response.status).toBe(404); expect(await response.json()).toEqual({ success: false, error: "BILLING_DISABLED" });
  });
});
