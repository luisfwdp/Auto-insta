import { createHmac } from "node:crypto";
import type Redis from "ioredis";
import "server-only";
import { getRateLimitRedis, incrementRateLimit } from "./rate-limit-store";
import { requestRateOrigin } from "./request-ip";
export { requestIp } from "./request-ip";

const WINDOW_SECONDS = 15 * 60;
const IP_LIMIT = 10;
const ACCOUNT_LIMIT = 5;
const MCP_OAUTH_IP_LIMIT = 30;

function fingerprint(value: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is required for auth rate limiting");
  return createHmac("sha256", secret).update(value).digest("hex");
}

export async function checkMagicLinkRateLimit({
  headers,
  email,
  redis,
}: {
  headers: Headers;
  email: string;
  redis?: Redis;
}): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const normalizedEmail = email.trim().toLowerCase();
  const store = redis ?? await getRateLimitRedis();
  const ipKey = `auth:magic-link:ip:${fingerprint(requestRateOrigin(headers))}`;
  const accountKey = `auth:magic-link:account:${fingerprint(normalizedEmail)}`;
  const ip = await incrementRateLimit(store, ipKey, WINDOW_SECONDS);
  if (ip.count > IP_LIMIT) return { allowed: false, retryAfter: ip.ttl };
  const account = await incrementRateLimit(store, accountKey, WINDOW_SECONDS);

  if (account.count > ACCOUNT_LIMIT) {
    return { allowed: false, retryAfter: Math.max(ip.ttl, account.ttl) };
  }
  return { allowed: true };
}

export async function checkMcpOAuthRateLimit({
  headers,
  redis,
}: {
  headers: Headers;
  redis?: Redis;
}): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const key = `auth:mcp-oauth:ip:${fingerprint(requestRateOrigin(headers))}`;
  const result = await incrementRateLimit(redis ?? await getRateLimitRedis(), key, WINDOW_SECONDS);
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
