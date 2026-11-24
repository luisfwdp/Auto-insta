import { NextResponse, type NextRequest } from "next/server";
import { isTrustedBrowserOrigin } from "@/lib/api/origin";
import { requestIp } from "@/lib/api/request-ip";
import { requestLimitResponse, type RequestLimitPolicy } from "@/lib/api/request-rate-limit";

// Every page under app/(dashboard). The layout there already refuses requests
// without a session; this redirect only keeps the page the user asked for in
// callbackUrl so the magic link brings them back to it.
export const PROTECTED_PREFIXES = [
  "/dashboard",
  "/overview",
  "/campaigns",
  "/automations",
  "/inbox",
  "/onboarding",
  "/logs",
  "/diagnostics",
  "/settings",
  "/billing",
  "/scheduling",
  "/speed-post",
];

function hasSessionCookie(request: NextRequest): boolean {
  return (
    request.cookies.has("authjs.session-token") ||
    request.cookies.has("__Secure-authjs.session-token") ||
    request.cookies.has("next-auth.session-token") ||
    request.cookies.has("__Secure-next-auth.session-token")
  );
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith("/api/") && !isTrustedBrowserOrigin(request)) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 }
    );
  }
  // Provider callbacks and cron keep their own signature/token/body guards.
  // Do not let a shared provider IP or a Redis outage starve valid webhooks.
  const provider = pathname === "/api/webhook" || pathname === "/api/billing/webhook"
    || pathname.startsWith("/api/zernio/webhook/") || pathname.startsWith("/api/cron/");
  let policy: RequestLimitPolicy | undefined;
  if (request.method === "POST" && (pathname === "/login" || pathname === "/api/auth/signin/resend")) policy = "authRequest";
  else if (pathname === "/api/auth/callback/resend") policy = "authVerify";
  else if (pathname.startsWith("/api/") && !provider) policy = "api";
  if (policy) {
    const denied = await requestLimitResponse(policy, requestIp(request.headers));
    if (denied) return denied;
  }
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  const isLogin = pathname === "/login";
  const isAuthenticated = hasSessionCookie(request);

  if (isProtected && !isAuthenticated) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isLogin && isAuthenticated) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/overview/:path*",
    "/campaigns/:path*",
    "/automations/:path*",
    "/inbox/:path*",
    "/onboarding/:path*",
    "/logs/:path*",
    "/diagnostics/:path*",
    "/settings/:path*",
    "/billing/:path*",
    "/scheduling/:path*",
    "/speed-post/:path*",
    "/login",
    "/api/:path*",
  ],
};
