import "server-only";
import Redis from "ioredis";
import { redisOptionsFromUrl } from "@/lib/queue/client";

let connection: Redis | undefined;
let connecting: Promise<unknown> | undefined;
let retryAt = 0;

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
