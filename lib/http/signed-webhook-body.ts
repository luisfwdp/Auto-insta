const MAX_WEBHOOK_BYTES = 512 * 1024;
const WEBHOOK_READ_TIMEOUT_MS = 4_000;

type WebhookBody =
  | { bytes: Buffer; status?: never }
  | { bytes?: never; status: 400 | 408 | 413 };

export async function readSignedWebhookBody(request: Request): Promise<WebhookBody> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > MAX_WEBHOOK_BYTES) return { status: 413 };
  if (!request.body) return { bytes: Buffer.alloc(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, WEBHOOK_READ_TIMEOUT_MS);

  try {
    while (true) {
      const result = await reader.read();
      if (timedOut) return { status: 408 };
      if (result.done) return { bytes: Buffer.concat(chunks, size) };
      size += result.value.byteLength;
      if (size > MAX_WEBHOOK_BYTES) return { status: 413 };
      chunks.push(result.value);
    }
  } catch {
    return { status: 400 };
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
