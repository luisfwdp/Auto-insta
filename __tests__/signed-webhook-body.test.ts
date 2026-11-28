import { afterEach, describe, expect, it, vi } from "vitest";
import { readSignedWebhookBody } from "@/lib/http/signed-webhook-body";

function request(body: ReadableStream<Uint8Array>, headers?: HeadersInit) {
  return new Request("https://example.test/webhook", {
    method: "POST", body, headers, duplex: "half",
  } as RequestInit);
}

describe("signed webhook reads", () => {
  afterEach(() => vi.useRealTimers());

  it("enforces the byte limit even when the declared length is small", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    await expect(readSignedWebhookBody(request(body, { "content-length": "20" }))).resolves.toEqual({ status: 413 });
  });

  it("stops waiting when the body does not finish", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const pending = readSignedWebhookBody(request(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(4_001);
    await expect(pending).resolves.toEqual({ status: 408 });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
