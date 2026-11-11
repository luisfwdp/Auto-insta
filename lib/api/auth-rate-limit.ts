import { createHmac } from "node:crypto";
import type Redis from "ioredis";
import { getRedisConnection } from "@/lib/queue/client";

const WINDOW_SECONDS = 15 * 60;
const IP_LIMIT = 10;
const ACCOUNT_LIMIT = 5;
const MCP_OAUTH_IP_LIMIT = 30;

const INCREMENT_WITH_TTL = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("TTL", KEYS[1])
return { count, ttl }
`;

function fingerprint(value: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is required for auth rate limiting");
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function requestIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

async function increment(redis: Redis, key: string) {
  const result = (await redis.eval(
    INCREMENT_WITH_TTL,
    1,
    key,
    WINDOW_SECONDS
  )) as [number, number];
  return { count: Number(result[0]), ttl: Math.max(1, Number(result[1])) };
}

export async function checkMagicLinkRateLimit({
  headers,
  email,
  redis = getRedisConnection(),
}: {
  headers: Headers;
  email: string;
  redis?: Redis;
}): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const normalizedEmail = email.trim().toLowerCase();
  const ipKey = `auth:magic-link:ip:${fingerprint(requestIp(headers))}`;
  const accountKey = `auth:magic-link:account:${fingerprint(normalizedEmail)}`;
  const [ip, account] = await Promise.all([
    increment(redis, ipKey),
    increment(redis, accountKey),
  ]);

  if (ip.count > IP_LIMIT || account.count > ACCOUNT_LIMIT) {
    return { allowed: false, retryAfter: Math.max(ip.ttl, account.ttl) };
  }
  return { allowed: true };
}

export async function checkMcpOAuthRateLimit({
  headers,
  redis = getRedisConnection(),
}: {
  headers: Headers;
  redis?: Redis;
}): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const key = `auth:mcp-oauth:ip:${fingerprint(requestIp(headers))}`;
  const result = await increment(redis, key);
  return result.count > MCP_OAUTH_IP_LIMIT
    ? { allowed: false, retryAfter: result.ttl }
    : { allowed: true };
}

export const AUTH_RATE_LIMITS = {
  windowSeconds: WINDOW_SECONDS,
  ip: IP_LIMIT,
  account: ACCOUNT_LIMIT,
  mcpOAuthIp: MCP_OAUTH_IP_LIMIT,
} as const;
