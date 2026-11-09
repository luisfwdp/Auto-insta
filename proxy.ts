import { NextResponse, type NextRequest } from "next/server";
import { isTrustedBrowserOrigin } from "@/lib/api/origin";

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

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith("/api/") && !isTrustedBrowserOrigin(request)) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 }
    );
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
    "/scheduling/:path*",
    "/speed-post/:path*",
    "/login",
    "/api/:path*",
  ],
};
