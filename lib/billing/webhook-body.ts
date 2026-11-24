import { BillingError } from "./config";

export async function readWebhookBody(request: Request, maxBytes = 64 * 1024) {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new BillingError("BODY_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new BillingError("INVALID_BILLING_EVENT", 400);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let bytes = 0, text = "", timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BillingError("BODY_TIMEOUT", 408)), 4_000); });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new BillingError("BODY_TOO_LARGE", 413);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof BillingError) throw error;
    throw new BillingError("INVALID_BILLING_EVENT", 400);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
