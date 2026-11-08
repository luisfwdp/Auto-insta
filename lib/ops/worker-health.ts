import { getRedisConnection } from "@/lib/queue/client";
import { evaluateConsumer, getLastCanaryAt, type ConsumerState } from "@/lib/ops/worker-canary";

const WORKER_HEALTH_KEY = "health:worker:dm";
const WORKER_ALERTS_KEY = "alerts:worker:dm";
const WORKER_HEARTBEAT_TTL_SECONDS = 120;

export interface WorkerHeartbeat {
  status: "running";
  worker: "dm";
  pid: number;
  hostname?: string;
  startedAt?: string;
  consumerReadySince?: string | null;
  checkedAt: string;
}

export interface WorkerHealth {
  /** Heartbeat fresh (process alive, consumer ready) AND a canary processed recently. */
  healthy: boolean;
  heartbeat: WorkerHeartbeat | null;
  ageMs: number | null;
  consumer?: { state: ConsumerState; lastProcessedAt: string | null; ageMs: number | null };
}

export interface WorkerAlert {
  level: "warning" | "error";
  message: string;
  jobId?: string;
  instagramAccountId?: string;
  commentId?: string;
  createdAt: string;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function recordWorkerHeartbeat(
  heartbeat: Omit<WorkerHeartbeat, "checkedAt" | "status" | "worker">
) {
  const payload: WorkerHeartbeat = {
    ...heartbeat,
    status: "running",
    worker: "dm",
    checkedAt: new Date().toISOString(),
  };

  await getRedisConnection().set(
    WORKER_HEALTH_KEY,
    JSON.stringify(payload),
    "EX",
    WORKER_HEARTBEAT_TTL_SECONDS
  );
}

export async function getWorkerHealth(): Promise<WorkerHealth> {
  const [raw, lastCanaryAt] = await Promise.all([
    getRedisConnection().get(WORKER_HEALTH_KEY),
    getLastCanaryAt(),
  ]);
  const heartbeat = parseJson<WorkerHeartbeat>(raw);
  const consumer = evaluateConsumer(lastCanaryAt);

  if (!heartbeat) {
    return { healthy: false, heartbeat: null, ageMs: null, consumer };
  }

  const ageMs = Date.now() - new Date(heartbeat.checkedAt).getTime();
  return {
    healthy: ageMs <= WORKER_HEARTBEAT_TTL_SECONDS * 1000 && consumer.state === "processing",
    heartbeat,
    ageMs,
    consumer,
  };
}

export async function recordWorkerAlert(alert: Omit<WorkerAlert, "createdAt">) {
  const payload: WorkerAlert = {
    ...alert,
    createdAt: new Date().toISOString(),
  };

  const redis = getRedisConnection();
  await redis.lpush(WORKER_ALERTS_KEY, JSON.stringify(payload));
  await redis.ltrim(WORKER_ALERTS_KEY, 0, 24);
}

export async function getWorkerAlerts(limit = 10): Promise<WorkerAlert[]> {
  const values = await getRedisConnection().lrange(
    WORKER_ALERTS_KEY,
    0,
    Math.max(0, limit - 1)
  );

  return values
    .map((value) => parseJson<WorkerAlert>(value))
    .filter((value): value is WorkerAlert => Boolean(value));
}
