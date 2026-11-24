import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(), options: undefined as Record<string, unknown> | undefined, status: "wait" }));
vi.mock("ioredis", () => ({ default: class FakeRedis {
  constructor(options: Record<string, unknown>) { state.options = options; }
  get status() { return state.status; }
  connect() { return state.connect(); }
  disconnect() { return state.disconnect(); }
  on(...args: unknown[]) { state.on(...args); }
} }));
vi.mock("@/lib/queue/client", () => ({ redisOptionsFromUrl: () => ({ host: "localhost", maxRetriesPerRequest: null }) }));
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); state.status = "wait"; state.connect.mockReset(); state.disconnect.mockReset(); state.on.mockReset(); });
afterEach(() => vi.useRealTimers());
it("shares one bounded connect attempt without inheriting the worker's offline queue/retries", async () => {
  let ready!: () => void; state.connect.mockImplementation(() => new Promise<void>(resolve => { ready = () => { state.status = "ready"; resolve(); }; }));
  const { getRateLimitRedis } = await import("../lib/api/rate-limit-store");
  const requests = [getRateLimitRedis(), getRateLimitRedis(), getRateLimitRedis()];
  expect(state.connect).toHaveBeenCalledOnce(); ready();
  const connections = await Promise.all(requests); expect(new Set(connections).size).toBe(1);
  expect(state.options).toMatchObject({ enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 1500, commandTimeout: 1500 });
});
it("redacts connect errors and applies a short local reconnect cooldown", async () => {
  state.connect.mockRejectedValue(new Error("private-redis-password"));
  const { getRateLimitRedis } = await import("../lib/api/rate-limit-store");
  await expect(getRateLimitRedis()).rejects.toThrow("Rate limit store unavailable");
  await expect(getRateLimitRedis()).rejects.not.toThrow("private-redis");
  expect(state.connect).toHaveBeenCalledOnce(); expect(state.disconnect).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5001);
  state.connect.mockImplementation(async () => { state.status = "ready"; });
  await expect(getRateLimitRedis()).resolves.toBeDefined(); expect(state.connect).toHaveBeenCalledTimes(2);
});
