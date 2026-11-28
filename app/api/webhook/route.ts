import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  parseCommentEvents,
  verifyWebhookSignature,
} from "@/lib/meta/webhook";
import { processInstagramWebhook } from "@/lib/queue/process-webhook";
import { createRepeatedErrorThrottle } from "@/lib/ops/repeated-error-throttle";
import { readSignedWebhookBody } from "@/lib/http/signed-webhook-body";

// Reject every invalid signature, but persist at most one rejection per minute
// per warm instance. Use a fixed key so changing the attacker-controlled body
// or signature cannot create a new reporting bucket; no Redis call is needed.
const shouldLogInvalidSignature = createRepeatedErrorThrottle(60_000);

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

export async function POST(request: NextRequest) {
  const body = await readSignedWebhookBody(request);
  if (body.status) {
    return NextResponse.json({ success: false, error: "Webhook body rejected" }, { status: body.status });
  }
  const rawBody = body.bytes;
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature)) {
    // Record the attempt so a signature mismatch is visible rather than a
    // silent 401. This is the common symptom of FACEBOOK_APP_SECRET being
    // set to the wrong app's secret for the webhook's signing key.
    if (shouldLogInvalidSignature("invalid_signature")) {
      await prisma.operationalEvent
        .create({
          data: {
            source: "SYSTEM",
            level: "WARNING",
            message: "Webhook signature verification failed",
            payload: {
              hadSignatureHeader: Boolean(signature),
              bodyLength: rawBody.byteLength,
              bodySha256: createHash("sha256").update(rawBody).digest("hex"),
            },
          },
        })
        .catch(() => {});
    }
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json({ success: false, error: "Invalid webhook envelope" }, { status: 400 });
    }
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  try {
    await processInstagramWebhook({ payload: payload as Parameters<typeof parseCommentEvents>[0], provider: 'META' });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: 'Webhook processing failed' }, { status: 500 });
  }
}
