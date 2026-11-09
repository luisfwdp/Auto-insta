/**
 * NextAuth.js v5 — Auth Route Handler
 *
 * Uses the shared auth config from lib/auth.ts
 */

import { NextRequest, NextResponse } from "next/server";
import { handlers } from "@/lib/auth";
import { checkMagicLinkRateLimit } from "@/lib/api/auth-rate-limit";

export const GET = handlers.GET;

export async function POST(request: NextRequest) {
  // Direct calls to Auth.js are also protected. The login page's server action
  // applies the same limiter because it invokes signIn() without this route.
  if (request.nextUrl.pathname.endsWith("/signin/resend")) {
    const form = await request.clone().formData();
    const email = String(form.get("email") ?? "");
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
