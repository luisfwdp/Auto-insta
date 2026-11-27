import "server-only";
import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import type Redis from "ioredis";
import { getRateLimitRedis } from "./rate-limit-store";

// Separate budgets: uploading 100 files cannot consume cancellation capacity.
export const REQUEST_LIMITS = {
  api: { limit: 600, seconds: 60 },
  authRequest: { limit: 30, seconds: 900 },
  authVerify: { limit: 30, seconds: 900 },
  checkout: { limit: 10, seconds: 900 },
  cancellation: { limit: 10, seconds: 900 },
  trial: { limit: 10, seconds: 900 },
  media: { limit: 360, seconds: 900 },
  publishing: { limit: 120, seconds: 60 },
  leadCapture: { limit: 20, seconds: 600 },
} as const;
export type RequestLimitPolicy = keyof typeof REQUEST_LIMITS;
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export async function consumeRequestLimit(policy: RequestLimitPolicy, subject: string, redis?: Pick<Redis, "eval">) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || !subject || subject.length > 2048) throw new Error("Rate limit configuration unavailable");
  const budget = REQUEST_LIMITS[policy];
  const scope = process.env.VERCEL_ENV ?? "self-hosted";
  const hash = createHmac("sha256", secret).update(`${scope}\0${policy}\0${subject}`).digest("hex");
  const store = redis ?? await getRateLimitRedis();
  const result = await store.eval(INCREMENT, 1, `security:v1:${policy}:${hash}`, budget.seconds);
  if (!Array.isArray(result) || result.length !== 2) throw new Error("Rate limit store unavailable");
  const [count, ttl] = result.map(Number);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isInteger(ttl) || ttl < 0 || ttl > budget.seconds)
    throw new Error("Rate limit store unavailable");
  return { allowed: count <= budget.limit, retryAfter: Math.max(1, ttl) };
}

/** Never fall back to in-memory counters or allow requests on Redis failure. */
export async function requestLimitResponse(policy: RequestLimitPolicy, subject: string) {
  try {
    const result = await consumeRequestLimit(policy, subject);
    if (result.allowed) return null;
    return NextResponse.json({ success: false, error: "RATE_LIMITED" }, {
      status: 429, headers: { "Retry-After": String(result.retryAfter), "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ success: false, error: "REQUEST_TEMPORARILY_UNAVAILABLE" }, {
      status: 503, headers: { "Retry-After": "60", "Cache-Control": "private, no-store" },
    });
  }
}
