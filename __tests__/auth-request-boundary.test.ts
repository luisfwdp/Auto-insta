import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ handler: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/auth", () => ({ handlers: { POST: state.handler, GET: vi.fn() } }));
vi.mock("@/lib/api/auth-rate-limit", () => ({ checkMagicLinkRateLimit: state.limit }));
import { POST } from "../app/api/auth/[...nextauth]/route";
beforeEach(() => { state.handler.mockReset().mockImplementation(async request => new Response(await request.text())); state.limit.mockReset().mockResolvedValue({ allowed: true }); });
afterEach(() => vi.useRealTimers());
function req(body: BodyInit, contentType = "application/x-www-form-urlencoded") {
  return new NextRequest("https://app.example/api/auth/signin/resend", { method: "POST", headers: { "content-type": contentType }, body });
}
it.each(["application/x-www-form-urlencoded", "application/json"])("preserves the original %s body for Auth.js CSRF verification", async type => {
  const body = type.includes("json") ? JSON.stringify({ email: "person@example.test", csrfToken: "fixture-csrf" }) : "email=person%40example.test&csrfToken=fixture-csrf";
  const response = await POST(req(body, type)); expect(response.status).toBe(200); expect(await response.text()).toBe(body);
  expect(state.limit).toHaveBeenCalledWith(expect.objectContaining({ email: "person@example.test" }));
});
it("rejects streamed input larger than8KiB before the auth handler, without trusting Content-Length", async () => {
  const request = req(`email=person%40example.test&padding=${"x".repeat(8192)}`); request.headers.set("content-length", "1");
  expect((await POST(request)).status).toBe(400); expect(state.handler).not.toHaveBeenCalled();
});
it("bounds slow request bodies and does not hang awaiting cancellation of a cloned stream", async () => {
  vi.useFakeTimers();
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  const request = new NextRequest("https://app.example/api/auth/signin/resend", { method: "POST", body: stream, duplex: "half", headers: { "content-type": "application/x-www-form-urlencoded" } } as never);
  const response = POST(request); await vi.advanceTimersByTimeAsync(3001);
  expect((await response).status).toBe(400); expect(state.handler).not.toHaveBeenCalled();
  void request.body?.cancel();
});
it("turns malformed bodies into a generic400 without exposing parser details", async () => {
  const response = await POST(req("{private-token", "application/json"));
  expect(response.status).toBe(400); expect(await response.text()).not.toContain("private-token"); expect(state.handler).not.toHaveBeenCalled();
});
it("never invokes Auth.js when the email budget is blocked or unavailable", async () => {
  state.limit.mockResolvedValue({ allowed: false, retryAfter: 30 });
  const response = await POST(req("email=person%40example.test")); expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("30");
  state.limit.mockRejectedValue(new Error("private-redis-credentials"));
  const failed = await POST(req("email=person%40example.test")); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private-redis"); expect(state.handler).not.toHaveBeenCalled();
});
