import { createAsaasClient, AsaasError } from "./asaas-client";
import { BillingError, hasBillingProviderScope } from "./config";
import { recoverInterruptedCheckouts } from "./checkout";
import { processBillingCancellations } from "./cancellation";
import { enqueueBillingRecovery, processBillingInbox } from "./reconcile";
import { readBillingDeadLetters } from "./health";

export interface BillingMaintenanceSummary {
  interruptedCheckouts: number;
  cancellationsProcessed: number;
  recoveryEventsQueued: number;
  eventsProcessed: number;
  deadLetters: number;
}

export interface BillingMaintenanceOptions {
  intervalMs?: number;
  onSummary?: (summary: BillingMaintenanceSummary) => void | Promise<void>;
  onError?: (code: string) => void | Promise<void>;
}

function count(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new BillingError("BILLING_MAINTENANCE_INVALID_RESULT", 503);
  return value;
}

function errorCode(error: unknown) {
  if ((error instanceof BillingError || error instanceof AsaasError) && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) return error.code;
  return "BILLING_MAINTENANCE_UNAVAILABLE";
}

/** Maintenance survives a sales rollback. It never creates a new checkout. */
export async function runBillingMaintenanceOnce(): Promise<BillingMaintenanceSummary> {
  if (!hasBillingProviderScope()) return { interruptedCheckouts: 0, cancellationsProcessed: 0, recoveryEventsQueued: 0, eventsProcessed: 0, deadLetters: 0 };
  const gateway = createAsaasClient();
  const interrupted = await recoverInterruptedCheckouts();
  const cancellations = await processBillingCancellations(5, gateway);
  const recovery = await enqueueBillingRecovery();
  const inbox = await processBillingInbox(5, gateway);
  const deadLetters = await readBillingDeadLetters();
  // Explicit fields only: provider/resource objects must never enter telemetry.
  return { interruptedCheckouts: count(interrupted.count), cancellationsProcessed: count(cancellations.processed),
    recoveryEventsQueued: count(recovery.count), eventsProcessed: count(inbox.processed), deadLetters: count(deadLetters) };
}

/** One local tick at a time; durable leases handle restarts or another machine. */
export function startBillingMaintenance({ intervalMs = 30_000, onSummary, onError }: BillingMaintenanceOptions = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) throw new BillingError("BILLING_MAINTENANCE_CONFIGURATION", 503);
  if (!hasBillingProviderScope()) return { stop: async () => {} };
  const summarize = onSummary ?? ((summary: BillingMaintenanceSummary) => { console.log("[Billing Worker] Maintenance:", summary); });
  const report = onError ?? ((code: string) => { console.error("[Billing Worker] Maintenance failed:", code); });
  let stopped = false, lastErrorCode: string | undefined, inFlight: Promise<void> | undefined;
  async function reportCode(code: string) {
    if (code === lastErrorCode) return;
    lastErrorCode = code;
    // A failing observer must not crash the worker or disclose its error.
    try { await report(code); } catch {}
  }
  function tick() {
    if (stopped || inFlight) return;
    const running = (async () => {
      try {
        const summary = await runBillingMaintenanceOnce();
        const { deadLetters, ...activity } = summary;
        if (Object.values(activity).some(value => value > 0)) await summarize(summary);
        if (deadLetters > 0) await reportCode("BILLING_DEAD_LETTER");
        else lastErrorCode = undefined;
      } catch (error) {
        await reportCode(errorCode(error));
      }
    })();
    inFlight = running;
    void running.then(() => { if (inFlight === running) inFlight = undefined; });
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: async () => { stopped = true; clearInterval(timer); await inFlight; } };
}
