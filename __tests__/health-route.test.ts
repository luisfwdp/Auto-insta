import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn(async () => 1);
const getRedisConnection = vi.fn(() => ({ ping: vi.fn() }));
const getDMQueue = vi.fn(() => ({ getJobCounts: vi.fn() }));
const getWorkerHealth = vi.fn();

vi.mock("@/lib/db/client", () => ({
  prisma: { $queryRaw: queryRaw },
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection,
  getDMQueue,
}));
vi.mock("@/lib/ops/worker-health", () => ({
  getWorkerHealth,
}));

describe("GET /api/health", () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fails fast without opening Redis when REDIS_URL is absent", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "degraded",
      checks: {
        database: { status: "ok" },
        redis: { status: "error", detail: "REDIS_URL is not configured" },
        queue: { status: "error", detail: "REDIS_URL is not configured" },
        worker: { healthy: false, error: "REDIS_URL is not configured" },
      },
    });
    expect(getRedisConnection).not.toHaveBeenCalled();
    expect(getDMQueue).not.toHaveBeenCalled();
    expect(getWorkerHealth).not.toHaveBeenCalled();
  });
});

describe("GET /api/health with Redis configured", () => {
  beforeEach(() => {
    process.env.REDIS_URL = "redis://localhost:6379";
    getRedisConnection.mockReturnValue({ ping: vi.fn(async () => "PONG") });
    getDMQueue.mockReturnValue({ getJobCounts: vi.fn(async () => ({ waiting: 1, active: 0 })) });
  });
  afterEach(() => {
    delete process.env.REDIS_URL;
  });

  it("reports 503 when the consumer is stalled, even with only one job waiting", async () => {
    getWorkerHealth.mockResolvedValue({ healthy: false, heartbeat: { pid: 1 }, ageMs: 1000, consumer: { state: "stalled" } });
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.checks.worker.consumer.state).toBe("stalled");
  });

  it("reports 503 when the worker health read fails (Redis down)", async () => {
    getWorkerHealth.mockRejectedValue(new Error("ECONNREFUSED"));
    const { GET } = await import("@/app/api/health/route");
    expect((await GET()).status).toBe(503);
  });

  it("reports 200 when the consumer is processing", async () => {
    getWorkerHealth.mockResolvedValue({ healthy: true, heartbeat: { pid: 1 }, ageMs: 1000, consumer: { state: "processing" } });
    const { GET } = await import("@/app/api/health/route");
    expect((await GET()).status).toBe(200);
  });
});
