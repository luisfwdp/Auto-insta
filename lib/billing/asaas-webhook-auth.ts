import { createHash, timingSafeEqual } from "node:crypto";

/** Asaas uses a distinct header token, not a Meta HMAC or the API key. */
export function verifyAsaasWebhookToken(headers: Headers, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const expected = env.ASAAS_WEBHOOK_TOKEN;
  const actual = headers.get("asaas-access-token");
  if (!expected || expected.length < 32 || expected === env.ASAAS_API_KEY || !actual || actual.length > 1024) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(actual), hash(expected));
}
