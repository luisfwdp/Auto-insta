import { createHash } from "node:crypto";
import { getRedisConnection } from "@/lib/queue/client";

/**
 * Server-side record of an OAuth nonce, so a state can be consumed exactly
 * once. Only a hash of the nonce is stored; the value is the user it was
 * issued to. GETDEL makes the check-and-consume atomic: of two concurrent
 * callbacks carrying the same state, only one gets the record back.
 */
function key(nonce: string): string {
  return `oauth:ig:nonce:${createHash("sha256").update(nonce).digest("hex")}`;
}

export async function rememberOAuthNonce(
  nonce: string,
  userId: string,
  ttlSeconds: number
): Promise<void> {
  await getRedisConnection().set(key(nonce), userId, "EX", ttlSeconds);
}

/** True only for the first caller, and only for the user it was issued to. */
export async function consumeOAuthNonce(nonce: string, userId: string): Promise<boolean> {
  const owner = await getRedisConnection().getdel(key(nonce));
  return owner === userId;
}
