import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createOperationalEvent = vi.hoisted(() => vi.fn());
const verifyWebhookSignature = vi.hoisted(() => vi.fn());
const processInstagramWebhook = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  prisma: { operationalEvent: { create: createOperationalEvent } },
}));
vi.mock("@/lib/meta/webhook", () => ({
  parseCommentEvents: vi.fn(),
  verifyWebhookSignature,
}));
vi.mock("@/lib/queue/process-webhook", () => ({ processInstagramWebhook }));

let POST: typeof import("@/app/api/webhook/route").POST;

function request(body: string, signature: string | null = "sha256=invalid") {
  return new NextRequest("http://localhost/api/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
    body,
  });
}

describe("webhook rejection logging", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T17:00:00Z"));
    createOperationalEvent.mockReset().mockResolvedValue({});
    verifyWebhookSignature.mockReset().mockReturnValue(false);
    processInstagramWebhook.mockReset().mockResolvedValue(undefined);
    ({ POST } = await import("@/app/api/webhook/route"));
  });
  afterEach(() => vi.useRealTimers());

  it("records a correlation hash without persisting untrusted body content", async () => {
    const body = JSON.stringify({ message: "private customer content", sender: "user_1" });
    const response = await POST(new NextRequest("http://localhost/api/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": "sha256=invalid" },
      body,
    }));

    expect(response.status).toBe(401);
    expect(processInstagramWebhook).not.toHaveBeenCalled();
    expect(createOperationalEvent).toHaveBeenCalledOnce();
    const payload = createOperationalEvent.mock.calls[0][0].data.payload;
    expect(payload).toEqual({
      hadSignatureHeader: true,
      bodyLength: body.length,
      bodySha256: createHash("sha256").update(body).digest("hex"),
    });
    expect(JSON.stringify(payload)).not.toContain("private customer content");
    expect(JSON.stringify(payload)).not.toContain("user_1");
  });

  it("rejects 100 concurrent invalid requests while persisting only one event", async () => {
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => POST(
      request(JSON.stringify({ attackerControlled: index }), index % 2 ? `sha256=${index}` : null)
    )));
    expect(responses.every((response) => response.status === 401)).toBe(true);
    expect(verifyWebhookSignature).toHaveBeenCalledTimes(100);
    expect(createOperationalEvent).toHaveBeenCalledOnce();
    expect(processInstagramWebhook).not.toHaveBeenCalled();
  });

  it("rejects an unsupported object before invoking any signed diagnostic", async () => {
    const response = await POST(request(JSON.stringify({ object: "page", entry: [] })));
    expect(response.status).toBe(401);
    expect(processInstagramWebhook).not.toHaveBeenCalled();
  });

  it("allows a new diagnostic after the reporting window", async () => {
    await POST(request("first"));
    vi.setSystemTime(Date.now() + 59_999);
    await POST(request("second"));
    expect(createOperationalEvent).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 1);
    expect((await POST(request("third"))).status).toBe(401);
    expect(createOperationalEvent).toHaveBeenCalledTimes(2);
  });

  it("keeps rejecting requests without retrying a failed diagnostic write", async () => {
    createOperationalEvent.mockRejectedValue(new Error("database unavailable"));
    expect((await POST(request("first"))).status).toBe(401);
    expect((await POST(request("second"))).status).toBe(401);
    expect(createOperationalEvent).toHaveBeenCalledOnce();
  });

  it("processes signed events even after invalid traffic fills the log window", async () => {
    await POST(request("invalid"));
    verifyWebhookSignature.mockReturnValue(true);
    const payload = { object: "instagram", entry: [] };
    expect((await POST(request(JSON.stringify(payload), "sha256=valid"))).status).toBe(200);
    expect(processInstagramWebhook).toHaveBeenCalledWith({ payload, provider: "META" });
    expect(createOperationalEvent).toHaveBeenCalledOnce();
  });

  it("authenticates the original UTF-8 bytes before decoding the payload", async () => {
    verifyWebhookSignature.mockReturnValue(true);
    const payload = { object: "instagram", entry: [], label: "Olá 🎵" };
    const raw = "\ufeff" + JSON.stringify(payload) + "\n";
    expect((await POST(request(raw, "sha256=valid"))).status).toBe(200);
    expect(verifyWebhookSignature).toHaveBeenCalledWith(Buffer.from(raw), "sha256=valid");
    expect(processInstagramWebhook).toHaveBeenCalledWith({ payload, provider: "META" });
  });
});
