import { NextResponse } from "next/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getBaseUrl, getMissingInstagramOAuthEnv } from "@/lib/env";
import {
  OAUTH_NONCE_COOKIE,
  STATE_MAX_AGE_MS,
  createOAuthNonce,
  createOAuthState,
  getAuthorizationUrl,
} from "@/lib/meta/oauth";
import { rememberOAuthNonce } from "@/lib/meta/oauth-nonce";

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.redirect(`${getBaseUrl()}/login`);
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?instagram=forbidden`);
  }

  // getAuthorizationUrl and createOAuthState call requireEnv, which throws.
  // Without this check an incomplete .env surfaces as a 500 on a plain <a>
  // navigation, which reads to the user as the button doing nothing at all.
  const missingEnv = getMissingInstagramOAuthEnv();
  if (missingEnv.length > 0) {
    return NextResponse.redirect(
      `${getBaseUrl()}/settings?instagram=misconfigured&missing=${encodeURIComponent(
        missingEnv.join(",")
      )}`
    );
  }

  const redirectUri = `${getBaseUrl()}/api/instagram/callback`;
  const nonce = createOAuthNonce();
  const state = createOAuthState(context.workspaceId, context.userId, nonce);
  await rememberOAuthNonce(nonce, context.userId, Math.floor(STATE_MAX_AGE_MS / 1000));

  const response = NextResponse.redirect(getAuthorizationUrl(redirectUri, state));
  // Lax, not Strict: Meta sends the browser back with a top-level GET from
  // facebook.com, which Lax cookies accompany.
  response.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: redirectUri.startsWith("https://"),
    sameSite: "lax",
    path: "/api/instagram/callback",
    maxAge: Math.floor(STATE_MAX_AGE_MS / 1000),
  });
  return response;
}
