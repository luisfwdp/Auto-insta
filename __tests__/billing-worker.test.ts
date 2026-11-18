/** Scheduler boundaries only: no BullMQ/DB/provider is started by this suite. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ configured: true, order: [] as string[], factory: vi.fn(), recover: vi.fn(), cancel: vi.fn(), enqueue: vi.fn(), inbox: vi.fn(), deadLetters: vi.fn(),
  gateway: { createHostedCheckout: vi.fn(), getSubscription: vi.fn(), cancelSubscription: vi.fn() } }));
vi.mock("@/lib/billing/config", async importOriginal => ({ ...await importOriginal<typeof import("../lib/billing/config")>(), hasBillingProviderScope: () => state.configured }));
vi.mock("@/lib/billing/asaas-client", async importOriginal => ({ ...await importOriginal<typeof import("../lib/billing/asaas-client")>(), createAsaasClient: () => state.factory() }));
vi.mock("@/lib/billing/checkout", () => ({ recoverInterruptedCheckouts: (...args: unknown[]) => state.recover(...args) }));
vi.mock("@/lib/billing/cancellation", () => ({ processBillingCancellations: (...args: unknown[]) => state.cancel(...args) }));
vi.mock("@/lib/billing/reconcile", () => ({ enqueueBillingRecovery: (...args: unknown[]) => state.enqueue(...args), processBillingInbox: (...args: unknown[]) => state.inbox(...args) }));
vi.mock("@/lib/billing/health", () => ({ readBillingDeadLetters: (...args: unknown[]) => state.deadLetters(...args) }));

import { startBillingMaintenance, runBillingMaintenanceOnce, type BillingMaintenanceOptions } from "../lib/billing/worker";
import { BillingError } from "../lib/billing/config";
import { AsaasError } from "../lib/billing/asaas-client";

const zero = { interruptedCheckouts: 0, cancellationsProcessed: 0, recoveryEventsQueued: 0, eventsProcessed: 0, deadLetters: 0 };
let controllers: ReturnType<typeof startBillingMaintenance>[];
let deferredCleanup: (() => void)[];
function start(options?: BillingMaintenanceOptions) { const controller = startBillingMaintenance(options); controllers.push(controller); return controller; }
function deferred<T>(value: T) {
  let finish!: (value: T) => void;
  const promise = new Promise<T>(resolve => { finish = resolve; });
  const resolve = () => finish(value); deferredCleanup.push(resolve);
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers(); controllers = []; deferredCleanup = []; state.configured = true; state.order = [];
  state.factory.mockReset().mockImplementation(() => { state.order.push("gateway"); return state.gateway; });
  state.recover.mockReset().mockImplementation(async () => { state.order.push("recover"); return { count: 0 }; });
  state.cancel.mockReset().mockImplementation(async () => { state.order.push("cancel"); return { processed: 0 }; });
  state.enqueue.mockReset().mockImplementation(async () => { state.order.push("enqueue"); return { count: 0 }; });
  state.inbox.mockReset().mockImplementation(async () => { state.order.push("inbox"); return { processed: 0 }; });
  state.deadLetters.mockReset().mockImplementation(async () => { state.order.push("health"); return 0; });
  for (const mock of Object.values(state.gateway)) mock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const resolve of deferredCleanup) resolve();
  for (const controller of controllers) await controller.stop();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs();
});

describe("billing maintenance scheduling", () => {
  it("reports persisted dead letters even when processing returns no completed jobs", async () => {
    const onError = vi.fn(), onSummary = vi.fn(); state.deadLetters.mockResolvedValue(2);
    start({ intervalMs: 1_000, onError, onSummary }); await vi.advanceTimersByTimeAsync(2_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith("BILLING_DEAD_LETTER");
    expect(onSummary).not.toHaveBeenCalled();
    expect(state.cancel).toHaveBeenCalledTimes(3); expect(state.inbox).toHaveBeenCalledTimes(3);
  });
  it("does no financial work or timer setup without a configured provider scope", async () => {
    state.configured = false;
    const onSummary = vi.fn(), onError = vi.fn();
    expect(await runBillingMaintenanceOnce()).toEqual(zero);
    const controller = start({ onSummary, onError });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000); await controller.stop();
    for (const mock of [state.factory, state.recover, state.cancel, state.enqueue, state.inbox, state.deadLetters, onSummary, onError]) expect(mock).not.toHaveBeenCalled();
  });
  it("boot-kicks immediately then repeats on the default30s interval", async () => {
    start();
    await vi.advanceTimersByTimeAsync(0); expect(state.factory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999); expect(state.factory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(state.factory).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });
  it("uses one gateway and performs recovery, cancellation, recovery-enqueue and inbox sequentially", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");
    state.recover.mockResolvedValue({ count: 2, privatePayload: "fake-secret" });
    state.cancel.mockResolvedValue({ processed: 3, customerId: "cus_private" });
    state.enqueue.mockResolvedValue({ count: 4, resourceIds: ["private"] });
    state.inbox.mockResolvedValue({ processed: 5, providerData: "fake-private" });
    const summary = await runBillingMaintenanceOnce();
    expect(summary).toEqual({ interruptedCheckouts: 2, cancellationsProcessed: 3, recoveryEventsQueued: 4, eventsProcessed: 5, deadLetters: 0 });
    expect(state.factory).toHaveBeenCalledOnce();
    expect(state.recover).toHaveBeenCalledExactlyOnceWith();
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith(5, state.gateway);
    expect(state.enqueue).toHaveBeenCalledExactlyOnceWith();
    expect(state.inbox).toHaveBeenCalledExactlyOnceWith(5, state.gateway);
    expect(state.deadLetters).toHaveBeenCalledExactlyOnceWith();
    expect(state.gateway.createHostedCheckout).not.toHaveBeenCalled();
    expect(JSON.stringify(summary)).not.toMatch(/fake|private|cus_/);
    state.order = []; state.recover.mockImplementation(async () => { state.order.push("recover"); return { count: 0 }; });
    state.cancel.mockImplementation(async () => { state.order.push("cancel"); return { processed: 0 }; });
    state.enqueue.mockImplementation(async () => { state.order.push("enqueue"); return { count: 0 }; });
    state.inbox.mockImplementation(async () => { state.order.push("inbox"); return { processed: 0 }; });
    await runBillingMaintenanceOnce(); expect(state.order).toEqual(["gateway", "recover", "cancel", "enqueue", "inbox", "health"]);
  });
  it("does not overlap ticks while the previous durable work is pending", async () => {
    const pending = deferred({ count: 0 }); state.recover.mockReturnValue(pending.promise);
    start({ intervalMs: 1_000 }); await vi.advanceTimersByTimeAsync(9_000);
    expect(state.factory).toHaveBeenCalledOnce(); expect(state.recover).toHaveBeenCalledOnce();
    expect(state.cancel).not.toHaveBeenCalled();
    pending.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(state.cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000); expect(state.factory).toHaveBeenCalledTimes(2);
  });
  it("stops the timer and drains the in-flight tick, including the remaining durable steps", async () => {
    const pending = deferred({ count: 0 }); state.recover.mockReturnValue(pending.promise);
    const controller = start({ intervalMs: 1_000 }); await vi.advanceTimersByTimeAsync(0);
    let drained = false; const stop = controller.stop().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0); expect(drained).toBe(false); expect(state.factory).toHaveBeenCalledOnce();
    pending.resolve(); await stop;
    expect(drained).toBe(true); expect(state.inbox).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000); expect(state.factory).toHaveBeenCalledOnce(); await controller.stop();
  });
  it.each([0, 999, 300_001, 1_000.5, NaN, Infinity, "30000"])("rejects unsafe intervals %s before any effect", intervalMs => {
    expect(() => startBillingMaintenance({ intervalMs: intervalMs as number })).toThrow(expect.objectContaining({ code: "BILLING_MAINTENANCE_CONFIGURATION" }));
    expect(vi.getTimerCount()).toBe(0); expect(state.factory).not.toHaveBeenCalled();
  });
  it.each([1_000, 300_000])("accepts the interval boundary%s", async intervalMs => {
    const controller = start({ intervalMs }); await vi.advanceTimersByTimeAsync(0);
    expect(state.factory).toHaveBeenCalledOnce(); await controller.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not emit success telemetry for idle ticks and only passes allowlisted counters for real work", async () => {
    const onSummary = vi.fn(); start({ intervalMs: 1_000, onSummary });
    await vi.advanceTimersByTimeAsync(0); expect(onSummary).not.toHaveBeenCalled();
    state.cancel.mockResolvedValue({ processed: 1, rawCard: "fake-private" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onSummary).toHaveBeenCalledExactlyOnceWith({ ...zero, cancellationsProcessed: 1 });
    expect(console.log).not.toHaveBeenCalled();
  });
  it("defaults to safe counter/code console output without passing error objects", async () => {
    state.inbox.mockResolvedValueOnce({ processed: 1 });
    start({ intervalMs: 1_000 }); await vi.advanceTimersByTimeAsync(0);
    expect(console.log).toHaveBeenCalledExactlyOnceWith("[Billing Worker] Maintenance:", { ...zero, eventsProcessed: 1 });
    state.recover.mockRejectedValue(new Error("fake-secret-token in stack"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("[Billing Worker] Maintenance failed:", "BILLING_MAINTENANCE_UNAVAILABLE");
  });
  it("deduplicates the same safe error until its code changes or a tick succeeds", async () => {
    const onError = vi.fn(); state.recover.mockRejectedValue(new BillingError("DATABASE_UNAVAILABLE"));
    start({ intervalMs: 1_000, onError }); await vi.advanceTimersByTimeAsync(2_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith("DATABASE_UNAVAILABLE");
    state.recover.mockRejectedValue(new AsaasError("UNAVAILABLE")); await vi.advanceTimersByTimeAsync(1_000);
    expect(onError.mock.calls).toEqual([["DATABASE_UNAVAILABLE"], ["UNAVAILABLE"]]);
    state.recover.mockResolvedValue({ count: 0 }); await vi.advanceTimersByTimeAsync(1_000);
    state.recover.mockRejectedValue(new AsaasError("UNAVAILABLE")); await vi.advanceTimersByTimeAsync(1_000);
    expect(onError.mock.calls).toEqual([["DATABASE_UNAVAILABLE"], ["UNAVAILABLE"], ["UNAVAILABLE"]]);
  });
  it.each([
    new Error("fake-api-key fake-customer"), { code: "FAKE_TOKEN", message: "fake-private" },
    new BillingError("secret=private\nheader"), new BillingError("A".repeat(65)),
  ])("redacts arbitrary error objects and malformed typed codes %#", async error => {
    const onError = vi.fn(); state.factory.mockImplementation(() => { throw error; });
    start({ onError }); await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledExactlyOnceWith("BILLING_MAINTENANCE_UNAVAILABLE");
    expect(state.recover).not.toHaveBeenCalled();
  });
  it("isolates errors thrown by the observer and keeps scheduling without leaking them", async () => {
    const onError = vi.fn().mockRejectedValue(new Error("fake-observer-secret"));
    state.recover.mockRejectedValue(new Error("fake-provider-secret"));
    start({ intervalMs: 1_000, onError }); await vi.advanceTimersByTimeAsync(2_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith("BILLING_MAINTENANCE_UNAVAILABLE");
    expect(state.factory).toHaveBeenCalledTimes(3); expect(console.error).not.toHaveBeenCalled();
  });
  it("redacts a failing success observer and deduplicates repeated observer failures", async () => {
    state.inbox.mockResolvedValue({ processed: 1 });
    const onSummary = vi.fn().mockRejectedValue(new Error("fake-observer-secret")), onError = vi.fn();
    start({ intervalMs: 1_000, onSummary, onError }); await vi.advanceTimersByTimeAsync(2_000);
    expect(onSummary).toHaveBeenCalledTimes(3); expect(onError).toHaveBeenCalledExactlyOnceWith("BILLING_MAINTENANCE_UNAVAILABLE");
  });
  it("rejects nonnumeric counters rather than forwarding raw service data into telemetry", async () => {
    state.recover.mockResolvedValue({ count: "fake-private" }); const onSummary = vi.fn(), onError = vi.fn();
    start({ onSummary, onError }); await vi.advanceTimersByTimeAsync(0);
    expect(onSummary).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledExactlyOnceWith("BILLING_MAINTENANCE_INVALID_RESULT");
  });
  it("keeps processing other jobs and includes the DLQ count in activity summaries without repeating alerts", async () => {
    state.deadLetters.mockResolvedValue(2); state.cancel.mockResolvedValue({ processed: 1 });
    const onSummary = vi.fn(), onError = vi.fn();
    start({ intervalMs: 1_000, onSummary, onError }); await vi.advanceTimersByTimeAsync(2_000);
    expect(state.cancel).toHaveBeenCalledTimes(3); expect(state.inbox).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledExactlyOnceWith("BILLING_DEAD_LETTER");
    expect(onSummary).toHaveBeenCalledTimes(3);
    for (const [summary] of onSummary.mock.calls) expect(summary).toEqual({ ...zero, cancellationsProcessed: 1, deadLetters: 2 });
  });
  it("clears the degraded state only when the DLQ drains, then alerts if dead letters reappear", async () => {
    const onError = vi.fn(); state.deadLetters.mockResolvedValue(2);
    start({ intervalMs: 1_000, onError }); await vi.advanceTimersByTimeAsync(1_000);
    state.deadLetters.mockResolvedValue(3); await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith("BILLING_DEAD_LETTER");
    state.deadLetters.mockResolvedValue(0); await vi.advanceTimersByTimeAsync(1_000);
    state.deadLetters.mockResolvedValue(1); await vi.advanceTimersByTimeAsync(1_000);
    expect(onError.mock.calls).toEqual([["BILLING_DEAD_LETTER"], ["BILLING_DEAD_LETTER"]]);
  });
  it("switches safely between a DLQ alert and an unavailable health read", async () => {
    const onError = vi.fn(); state.deadLetters.mockResolvedValue(2);
    start({ intervalMs: 1_000, onError }); await vi.advanceTimersByTimeAsync(0);
    state.deadLetters.mockRejectedValue(new Error("fake-private-db-credential")); await vi.advanceTimersByTimeAsync(2_000);
    state.deadLetters.mockResolvedValue(2); await vi.advanceTimersByTimeAsync(1_000);
    expect(onError.mock.calls).toEqual([["BILLING_DEAD_LETTER"], ["BILLING_MAINTENANCE_UNAVAILABLE"], ["BILLING_DEAD_LETTER"]]);
  });
});
