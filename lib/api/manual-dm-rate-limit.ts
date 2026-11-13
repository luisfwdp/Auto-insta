import { createHmac } from "node:crypto";
import type Redis from "ioredis";
import { getRedisConnection } from "@/lib/queue/client";

const WINDOW_SECONDS = 15 * 60;
const SEND_LIMIT = 60;

const INCREMENT_WITH_TTL = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("TTL", KEYS[1])
return { count, ttl }
`;

function fingerprint(value: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is required for manual DM rate limiting");
  }
  return createHmac("sha256", secret).update(value).digest("hex");
}

export async function checkManualDmRateLimit({
  workspaceId,
  instagramAccountId,
  redis = getRedisConnection(),
}: {
  workspaceId: string;
  instagramAccountId: string;
  redis?: Redis;
}): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const subject = fingerprint(`${workspaceId}:${instagramAccountId}`);
  const result = (await redis.eval(
    INCREMENT_WITH_TTL,
    1,
    `api:manual-dm:${subject}`,
    WINDOW_SECONDS
  )) as [number, number];
  const count = Number(result[0]);
  const retryAfter = Math.max(1, Number(result[1]));

  return count > SEND_LIMIT
    ? { allowed: false, retryAfter }
    : { allowed: true };
}

export const MANUAL_DM_RATE_LIMIT = {
  windowSeconds: WINDOW_SECONDS,
  sends: SEND_LIMIT,
} as const;
