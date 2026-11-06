import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { trackConsumerReadiness } from "@/lib/ops/worker-readiness";

function fakeWorker(waitResult: Promise<unknown>) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { waitUntilReady: () => waitResult });
}

describe("trackConsumerReadiness", () => {
  it("is not ready until the BullMQ consumer reports ready", async () => {
    let resolve!: () => void;
    const worker = fakeWorker(new Promise<void>((r) => (resolve = r)));
    const readiness = trackConsumerReadiness(worker);
    expect(readiness.isReady()).toBe(false);
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(readiness.isReady()).toBe(true);
    expect(readiness.readySince()).not.toBeNull();
  });

  it("drops readiness on error or close and recovers on ready", async () => {
    const worker = fakeWorker(Promise.resolve());
    const readiness = trackConsumerReadiness(worker);
    await Promise.resolve();
    await Promise.resolve();
    expect(readiness.isReady()).toBe(true);
    worker.emit("error", new Error("Connection is closed."));
    expect(readiness.isReady()).toBe(false);
    worker.emit("ready");
    expect(readiness.isReady()).toBe(true);
    worker.emit("closed");
    expect(readiness.isReady()).toBe(false);
  });

  it("stays not ready if the consumer never connects", async () => {
    const worker = fakeWorker(Promise.reject(new Error("ECONNREFUSED")));
    const readiness = trackConsumerReadiness(worker);
    await new Promise((r) => setTimeout(r, 0));
    expect(readiness.isReady()).toBe(false);
  });
});
