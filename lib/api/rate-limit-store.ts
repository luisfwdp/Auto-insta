import "server-only";
import Redis from "ioredis";
import { redisOptionsFromUrl } from "@/lib/queue/client";

let connection: Redis | undefined;
let connecting: Promise<unknown> | undefined;
let retryAt = 0;

const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export async function incrementRateLimit(store: Pick<Redis, "eval">, key: string, seconds: number) {
  const result = await store.eval(INCREMENT, 1, key, seconds);
  if (!Array.isArray(result) || result.length !== 2) throw new Error("Rate limit store unavailable");
  const [count, ttl] = result;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isInteger(ttl) || ttl < 0 || ttl > seconds) {
    throw new Error("Rate limit store unavailable");
  }
  return { count, ttl: Math.max(1, ttl) };
}

/** HTTP requests must not inherit BullMQ's unbounded offline queue/retries.
 * One bounded connection attempt per instance; no credential-bearing logs. */
export async function getRateLimitRedis(): Promise<Redis> {
  if (Date.now() < retryAt) throw new Error("Rate limit store unavailable");
  if (!connection) {
    connection = new Redis({ ...redisOptionsFromUrl(process.env.REDIS_URL ?? ""),
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      connectTimeout: 1500, commandTimeout: 1500, retryStrategy: () => null });
    connection.on("error", () => { retryAt = Date.now() + 5000; });
  }
  if (connection.status !== "ready") {
    connecting ??= connection.connect().catch(() => {
      connection?.disconnect(); retryAt = Date.now() + 5000;
      throw new Error("Rate limit store unavailable");
    }).finally(() => { connecting = undefined; });
    await connecting;
  }
  return connection;
}
