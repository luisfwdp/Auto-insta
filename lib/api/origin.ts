import type { NextRequest } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

export function isTrustedBrowserOrigin(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const origin = request.headers.get("origin");
  if (!origin) {
    // Signed webhooks and server-to-server clients normally omit Origin. A
    // cookie-authenticated write, however, is a browser session and must prove
    // its origin to prevent cross-site form submissions from reusing it.
    return !SESSION_COOKIES.some((name) => request.cookies.has(name));
  }

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
