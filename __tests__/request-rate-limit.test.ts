import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const state = vi.hoisted(() => ({ eval: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/api/rate-limit-store", () => ({ getRateLimitRedis: () => state.get() }));
import { consumeRequestLimit, requestLimitResponse, REQUEST_LIMITS } from "../lib/api/request-rate-limit";
import { requestIp } from "../lib/api/request-ip";
import { proxy } from "../proxy";
import { createBrowserCheckout } from "../lib/billing/browser-contract";
import { BILLING_PLANS } from "../lib/billing/catalog";
beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-rate-secret-with-32-characters"); vi.stubEnv("VERCEL", "1");
  state.eval.mockReset().mockImplementation(async (_script, _keys, _key, seconds) => [1, seconds]);
  state.get.mockReset().mockResolvedValue({ eval: state.eval });
});
afterEach(() => vi.unstubAllEnvs());
describe("server request budgets", () => {
  it.each(["BILLING_RATE_LIMIT_UNAVAILABLE", "REQUEST_TEMPORARILY_UNAVAILABLE"])("does not strand a browser checkout intent when %s denies before effects", async code => {
    const persist = vi.fn(); const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error: code }), { status: 503 }));
    await expect(createBrowserCheckout({ role: "OWNER", workspaceId: "workspace-a", requestId: "20000000-0000-4000-8000-000000000002", consent: true, previous: null, persist, fetcher,
      plan: { id: "essential-v1", name: "Essencial", amountCents: 7900, currency: "BRL", interval: "MONTHLY", trialDays: 3, cardRequiredForTrial: false, quotas: BILLING_PLANS["essential-v1"] } })).rejects.toThrow();
    expect(persist).toHaveBeenLastCalledWith(null); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("enforces the exact boundary and uses expiring opaque keys", async () => {
    state.eval.mockResolvedValueOnce([10, 900]).mockResolvedValueOnce([11, 456]);
    expect((await consumeRequestLimit("checkout", "private-workspace:owner" )).allowed).toBe(true);
    expect(await consumeRequestLimit("checkout", "private-workspace:owner")).toEqual({ allowed: false, retryAfter: 456 });
    const key = state.eval.mock.calls[0][2];
    expect(key).toMatch(/^security:v1:checkout:[a-f0-9]{64}$/); expect(key).not.toContain("private-workspace");
    expect(state.eval.mock.calls[0][3]).toBe(900);
  });
  it.each([null, [], [NaN, 1], [1, -1], [1, 901], [1.5, 60]])("fails closed for invalid Redis counters: %j", async value => {
    state.eval.mockResolvedValue(value);
    const response = await requestLimitResponse("checkout", "workspace:owner");
    expect(response?.status).toBe(503); expect(response?.headers.get("Retry-After")).toBe("60");
  });
  it("returns429/no-store/Retry-After without exposing Redis failures or identity", async () => {
    state.eval.mockResolvedValue([11, 12]); const limited = await requestLimitResponse("checkout", "private-email@example.test");
    expect(limited?.status).toBe(429); expect(limited?.headers.get("Retry-After")).toBe("12");
    expect(limited?.headers.get("Cache-Control")).toContain("no-store");
    expect(await limited?.text()).not.toContain("private-email");
    state.get.mockRejectedValue(new Error("secret-bearing redis URL"));
    const failed = await requestLimitResponse("checkout", "owner"); expect(failed?.status).toBe(503);
    expect(await failed?.text()).not.toContain("secret-bearing");
  });
  it("isolates tenants and operations; a100-file upload+confirmation fits media capacity", async () => {
    for (const [policy, subject] of [["checkout", "a:u"], ["cancellation", "a:u"], ["checkout", "b:u"]] as const) await consumeRequestLimit(policy, subject);
    expect(new Set(state.eval.mock.calls.map(call => call[2])).size).toBe(3);
    expect(REQUEST_LIMITS.media.limit).toBeGreaterThanOrEqual(100 * 2);
  });
  it("cannot let preview traffic consume the production budget even with shared Redis/secret", async () => {
    vi.stubEnv("VERCEL_ENV", "preview"); await consumeRequestLimit("checkout", "workspace:owner");
    vi.stubEnv("VERCEL_ENV", "production"); await consumeRequestLimit("checkout", "workspace:owner");
    expect(state.eval.mock.calls[0][2]).not.toBe(state.eval.mock.calls[1][2]);
  });
});
describe("proxy admission precedes protected work", () => {
  it.each([
    ["POST", "/login", "authRequest"], ["POST", "/api/auth/signin/resend", "authRequest"],
    ["GET", "/api/auth/callback/resend?token=private-token&email=person@example.test", "authVerify"],
    ["POST", "/api/automations", "api"],
  ])("blocks %s%s before its handler", async (method, path, policy) => {
    state.eval.mockImplementation(async (_script, _n, _key, seconds) => [1000, seconds]);
    const response = await proxy(new NextRequest(`https://app.example${path}`, { method, headers: { origin: "https://app.example", "x-vercel-forwarded-for": "203.0.113.1" } }));
    expect(response.status).toBe(429); expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(state.eval.mock.calls[0][2]).toContain(`:${policy}:`);
    expect(state.eval.mock.calls[0][2]).not.toContain("private-token");
  });
  it("refuses CSRF before spending any Redis budget", async () => {
    const response = await proxy(new NextRequest("https://app.example/api/billing/checkout", { method: "POST", headers: { origin: "https://evil.example" } }));
    expect(response.status).toBe(403); expect(state.eval).not.toHaveBeenCalled();
  });
  it.each(["/api/webhook", "/api/billing/webhook", "/api/zernio/webhook/workspace", "/api/cron/refresh-tokens"])("does not put provider traffic %s into a browser bucket", async path => {
    state.get.mockRejectedValue(new Error("Redis unavailable"));
    expect((await proxy(new NextRequest(`https://app.example${path}`, { method: "POST" }))).status).toBe(200);
    expect(state.get).not.toHaveBeenCalled();
  });
  it("does not exempt lookalike provider paths", async () => {
    state.eval.mockResolvedValue([1000, 60]);
    expect((await proxy(new NextRequest("https://app.example/api/billing/webhook-other"))).status).toBe(429);
  });
});
describe("trusted IP boundary", () => {
  it("prefers the Vercel proxy IP over a supplied forwarding chain", () => {
    expect(requestIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.4", "x-forwarded-for": "198.51.100.1, 198.51.100.2" }))).toBe("203.0.113.4");
  });
  it("does not trust direct client headers without deployment opt-in", () => {
    vi.stubEnv("VERCEL", ""); vi.stubEnv("TRUST_PROXY_HEADERS", "false");
    expect(requestIp(new Headers({ "x-forwarded-for": "203.0.113.4" }))).toBe("unknown");
  });
  it("rejects malformed addresses and normalizes IPv6 aliases", () => {
    expect(requestIp(new Headers({ "x-vercel-forwarded-for": "attacker-controlled-text" }))).toBe("unknown");
    expect(requestIp(new Headers({ "x-vercel-forwarded-for": "2001:0DB8:0000:0000:0000:0000:0000:0001" }))).toBe("2001:db8::1");
  });
});
