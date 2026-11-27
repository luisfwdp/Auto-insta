import { randomUUID, createHmac } from "node:crypto";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { consumeRequestLimit, type RequestLimitPolicy } from "../lib/api/request-rate-limit";
const url = process.env.TEST_REDIS_URL;
const secret = `disposable-rate-test-${randomUUID()}`;
let redis: Redis;
const keys = new Set<string>();
function subject(policy: RequestLimitPolicy) {
  const value = randomUUID();
  keys.add(`security:v1:${policy}:${createHmac("sha256", secret).update(`${process.env.VERCEL_ENV ?? "self-hosted"}\0${policy}\0${value}`).digest("hex")}`);
  return value;
}
describe.skipIf(!url)("atomic budgets on disposable Redis", () => {
  beforeAll(async () => {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url!).hostname)) throw new Error("TEST_REDIS_URL must point to disposable loopback Redis");
    vi.stubEnv("NEXTAUTH_SECRET", secret); redis = new Redis(url!, { maxRetriesPerRequest: 1, connectTimeout: 1500 }); await redis.ping();
  });
  afterAll(async () => { if (redis) { if (keys.size) await redis.del(...keys); await redis.quit(); } vi.unstubAllEnvs(); });
  it("admits exactly10 of100 concurrent attempts across callers", async () => {
    const id = subject("checkout");
    const decisions = await Promise.all(Array.from({ length: 100 }, () => consumeRequestLimit("checkout", id, redis)));
    expect(decisions.filter(result => result.allowed)).toHaveLength(10);
    expect(decisions.filter(result => !result.allowed)).toHaveLength(90);
    for (const decision of decisions) expect(decision.retryAfter).toBeGreaterThan(0);
  });
  it("repairs missing expiration instead of permanently locking the subject", async () => {
    const id = subject("checkout"), key = [...keys].at(-1)!; await redis.set(key, "10");
    expect(await redis.ttl(key)).toBe(-1);
    expect((await consumeRequestLimit("checkout", id, redis)).allowed).toBe(false);
    expect(await redis.ttl(key)).toBeGreaterThan(0); expect(await redis.ttl(key)).toBeLessThanOrEqual(900);
  });
  it("gives cancellation its own quota after checkout is exhausted", async () => {
    const id = subject("checkout");
    await Promise.all(Array.from({ length: 11 }, () => consumeRequestLimit("checkout", id, redis)));
    keys.add(`security:v1:cancellation:${createHmac("sha256", secret).update(`${process.env.VERCEL_ENV ?? "self-hosted"}\0cancellation\0${id}`).digest("hex")}`);
    expect((await consumeRequestLimit("cancellation", id, redis)).allowed).toBe(true);
    expect((await consumeRequestLimit("checkout", id, redis)).allowed).toBe(false);
  });
});
