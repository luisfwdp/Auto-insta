/**
 * Worker health must prove the BullMQ consumer processes jobs, not only that
 * the process can write to Redis: a stalled consumer with Redis up must read
 * as unhealthy whatever the queue depth.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
const redis = vi.hoisted(() => ({ down: false }));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({
    set: vi.fn(async (k: string, v: string) => {
      if (redis.down) throw new Error("ECONNREFUSED");
      store.set(k, v);
      return "OK";
    }),
    get: vi.fn(async (k: string) => {
      if (redis.down) throw new Error("ECONNREFUSED");
      return store.get(k) ?? null;
    }),
  }),
}));

import {
  CANARY_JOB_ID,
  CANARY_MAX_AGE_MS,
  enqueueCanary,
  evaluateConsumer,
  recordCanaryProcessed,
} from "@/lib/ops/worker-canary";
import { getWorkerHealth, recordWorkerHeartbeat } from "@/lib/ops/worker-health";

beforeEach(() => {
  store.clear();
  redis.down = false;
});

describe("canary job", () => {
  it("is enqueued with a fixed id, one attempt and no retention, so a stalled consumer never builds a backlog", async () => {
    const add = vi.fn();
    await enqueueCanary({ add } as never);
    expect(add).toHaveBeenCalledWith("worker-canary", { canary: true }, {
      jobId: CANARY_JOB_ID,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it("reads processing only for a recent canary", () => {
    const now = Date.now();
    expect(evaluateConsumer(new Date(now - 5_000).toISOString(), now).state).toBe("processing");
    expect(evaluateConsumer(new Date(now - CANARY_MAX_AGE_MS - 1).toISOString(), now).state).toBe("stalled");
    expect(evaluateConsumer(null, now).state).toBe("stalled");
  });
});

describe("getWorkerHealth", () => {
  it("is healthy when the worker is alive and a canary was processed", async () => {
    await recordWorkerHeartbeat({ pid: 1 });
    await recordCanaryProcessed();
    const health = await getWorkerHealth();
    expect(health.healthy).toBe(true);
    expect(health.consumer?.state).toBe("processing");
  });

  it("is unhealthy when the consumer stopped processing while Redis and the heartbeat are fine", async () => {
    await recordWorkerHeartbeat({ pid: 1 });
    await recordCanaryProcessed(new Date(Date.now() - CANARY_MAX_AGE_MS - 1_000));
    const health = await getWorkerHealth();
    expect(health.healthy).toBe(false);
    expect(health.consumer?.state).toBe("stalled");
  });

  it("is unhealthy when the canary was never processed", async () => {
    await recordWorkerHeartbeat({ pid: 1 });
    expect((await getWorkerHealth()).healthy).toBe(false);
  });

  it("is unhealthy when the worker is stopped (no heartbeat), even with a recent canary", async () => {
    await recordCanaryProcessed();
    expect((await getWorkerHealth()).healthy).toBe(false);
  });

  it("fails (callers report unhealthy) when Redis is unavailable", async () => {
    redis.down = true;
    await expect(getWorkerHealth()).rejects.toThrow();
  });
});
