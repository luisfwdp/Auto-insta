import { createHash } from "node:crypto";
import { getRedisConnection } from "@/lib/queue/client";

/**
 * Server-side record of an OAuth nonce, so a state can be consumed exactly
 * once. Only a hash of the nonce is stored; the value is the user and
 * workspace it was issued for. GETDEL makes the check-and-consume atomic: of two concurrent
 * callbacks carrying the same state, only one gets the record back.
 */
function key(nonce: string): string {
  return `oauth:ig:nonce:${createHash("sha256").update(nonce).digest("hex")}`;
}

export async function rememberOAuthNonce(
  nonce: string,
  userId: string,
  workspaceId: string,
  ttlSeconds: number
): Promise<void> {
  await getRedisConnection().set(key(nonce), owner(userId, workspaceId), "EX", ttlSeconds);
}

function owner(userId: string, workspaceId: string): string {
  return JSON.stringify([userId, workspaceId]);
}

/**
 * True only for the first caller, and only for the user and workspace it was
 * issued for. Throws when the store is unreachable; callers must fail closed.
 */
export async function consumeOAuthNonce(
  nonce: string,
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const stored = await getRedisConnection().getdel(key(nonce));
  return stored === owner(userId, workspaceId);
}
