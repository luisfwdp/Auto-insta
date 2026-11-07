/**
 * Tracks whether the BullMQ consumer can actually take jobs, so the worker
 * heartbeat stops (and /api/health turns unhealthy within the heartbeat TTL)
 * when the consumer loses Redis or closes, instead of reporting a live
 * process whose queue is stuck.
 */
export interface ReadinessSource {
  on(event: "ready" | "error" | "closed", listener: (...args: unknown[]) => void): unknown;
  waitUntilReady(): Promise<unknown>;
}

export interface ConsumerReadiness {
  isReady(): boolean;
  /** Last time the consumer became ready, for the heartbeat payload. */
  readySince(): string | null;
}

export function trackConsumerReadiness(worker: ReadinessSource): ConsumerReadiness {
  let ready = false;
  let since: string | null = null;
  const markReady = () => {
    if (!ready) since = new Date().toISOString();
    ready = true;
  };

  worker.on("ready", markReady);
  worker.on("error", () => {
    ready = false;
  });
  worker.on("closed", () => {
    ready = false;
  });
  worker.waitUntilReady().then(markReady, () => {
    ready = false;
  });

  return { isReady: () => ready, readySince: () => since };
}
