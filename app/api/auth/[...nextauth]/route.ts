/**
 * NextAuth.js v5 — Auth Route Handler
 *
 * Uses the shared auth config from lib/auth.ts
 */

import { NextRequest, NextResponse } from "next/server";
import { handlers } from "@/lib/auth";
import { checkMagicLinkRateLimit } from "@/lib/api/auth-rate-limit";

export const GET = handlers.GET;

/** Bound real bytes/time even for chunked or malformed sign-in requests.
 * Parse a clone so Auth.js still verifies the original body and CSRF token. */
async function signInEmail(request: NextRequest) {
  const reader = request.clone().body?.getReader();
  if (!reader) throw new Error("Invalid sign-in request");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "", timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Invalid sign-in request")), 3000); });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192) throw new Error("Invalid sign-in request");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    if (request.headers.get("content-type")?.includes("application/json")) return String(JSON.parse(text)?.email ?? "");
    const form = await new Request(request.url, { method: "POST", headers: request.headers, body: text }).formData();
    return String(form.get("email") ?? "");
  } catch {
    void reader.cancel().catch(() => {});
    throw new Error("Invalid sign-in request");
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export async function POST(request: NextRequest) {
  // Direct calls to Auth.js are also protected. The login page's server action
  // applies the same limiter because it invokes signIn() without this route.
  if (request.nextUrl.pathname.endsWith("/signin/resend")) {
    let email: string;
    try { email = await signInEmail(request); }
    catch { return NextResponse.json({ error: "Invalid sign-in request." }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
    try {
      const limit = await checkMagicLinkRateLimit({
        headers: request.headers,
        email,
      });
      if (!limit.allowed) {
        return NextResponse.json(
          { error: "Too many sign-in attempts. Try again later." },
          { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Sign-in is temporarily unavailable." },
        { status: 503, headers: { "Retry-After": "60" } }
      );
    }
  }
  return handlers.POST(request);
}
