import type { NextRequest } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isTrustedBrowserOrigin(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const origin = request.headers.get("origin");
  if (!origin) return true; // Webhooks and server-to-server clients do not send Origin.

  const allowed = new Set<string>([request.nextUrl.origin]);
  for (const value of [process.env.NEXTAUTH_URL, process.env.AUTH_URL]) {
    if (!value) continue;
    try {
      allowed.add(new URL(value).origin);
    } catch {
      // Invalid deployment configuration must never widen the allowlist.
    }
  }
  return allowed.has(origin);
}
