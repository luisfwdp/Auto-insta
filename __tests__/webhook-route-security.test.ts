import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createOperationalEvent = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  prisma: { operationalEvent: { create: createOperationalEvent } },
}));
vi.mock("@/lib/meta/webhook", () => ({
  parseCommentEvents: vi.fn(),
  verifyWebhookSignature: vi.fn(() => false),
}));
vi.mock("@/lib/queue/process-webhook", () => ({ processInstagramWebhook: vi.fn() }));

import { POST } from "@/app/api/webhook/route";

describe("webhook rejection logging", () => {
  beforeEach(() => {
    createOperationalEvent.mockReset().mockResolvedValue({});
  });

  it("records a correlation hash without persisting untrusted body content", async () => {
    const body = JSON.stringify({ message: "private customer content", sender: "user_1" });
    const response = await POST(new NextRequest("http://localhost/api/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": "sha256=invalid" },
      body,
    }));

    expect(response.status).toBe(401);
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
});
