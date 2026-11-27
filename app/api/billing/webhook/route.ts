import { NextRequest, NextResponse } from "next/server";
import { verifyAsaasWebhookToken } from "@/lib/billing/asaas-webhook-auth";
import { BillingError, getBillingProviderScope } from "@/lib/billing/config";
import { ingestBillingEvent } from "@/lib/billing/inbox";

const MAX_BYTES = 64 * 1024;
const headers = { "Cache-Control": "no-store" };

async function readBody(request: NextRequest) {
  if (Number(request.headers.get("content-length")) > MAX_BYTES) throw new BillingError("BODY_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new BillingError("INVALID_BILLING_EVENT", 400);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "", timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BillingError("BODY_TIMEOUT", 408)), 10_000); });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new BillingError("BODY_TOO_LARGE", 413);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof BillingError) throw error;
    throw new BillingError("INVALID_BILLING_EVENT", 400);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export async function POST(request: NextRequest) {
  if (process.env.PULSO_CHECKOUT_ENABLED === "true") return NextResponse.json({ received: true }, { headers });
  const configuredToken = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!configuredToken || configuredToken.length < 32 || configuredToken === process.env.ASAAS_API_KEY) return NextResponse.json({ success: false, error: "BILLING_CONFIGURATION" }, { status: 503, headers });
  // Do not read or parse the body until the distinct provider token authenticates.
  if (!verifyAsaasWebhookToken(request.headers)) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401, headers });
  try {
    getBillingProviderScope();
    await ingestBillingEvent(await readBody(request));
    // Keep ingestion available during billing rollback; never gate on BILLING_ENABLED.
    return NextResponse.json({ received: true }, { headers });
  } catch (error) {
    if (error instanceof BillingError) return NextResponse.json({ success: false, error: error.code }, { status: error.httpStatus, headers });
    return NextResponse.json({ success: false, error: "BILLING_INBOX_UNAVAILABLE" }, { status: 503, headers });
  }
}
