import { NextRequest, NextResponse } from "next/server";
import {
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
} from "@/lib/mcp/oauth";
import { checkMcpOAuthRateLimit } from "@/lib/api/auth-rate-limit";

function oauthError(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const limit = await checkMcpOAuthRateLimit({ headers: request.headers });
  if (!limit.allowed) {
    return NextResponse.json({ error: "slow_down" }, {
      status: 429,
      headers: { "retry-after": String(limit.retryAfter), "cache-control": "no-store" },
    });
  }
  const form = await request.formData().catch(() => null);
  if (!form) return oauthError("invalid_request");
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id");
  if (typeof clientId !== "string") return oauthError("invalid_client", 401);
  try {
    const result = grantType === "authorization_code"
      ? await exchangeAuthorizationCode({
          code: String(form.get("code") ?? ""),
          clientId,
          redirectUri: String(form.get("redirect_uri") ?? ""),
          codeVerifier: String(form.get("code_verifier") ?? ""),
        })
      : grantType === "refresh_token"
        ? await exchangeRefreshToken({
            refreshToken: String(form.get("refresh_token") ?? ""),
            clientId,
          })
        : null;
    if (!result) return oauthError("unsupported_grant_type");
    return NextResponse.json({
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: result.refreshToken,
      scope: result.scopes.join(" "),
    }, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  } catch {
    return oauthError("invalid_grant");
  }
}
