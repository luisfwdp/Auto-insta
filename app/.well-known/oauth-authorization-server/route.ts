import { NextResponse } from "next/server";
import { MCP_SCOPES, publicMcpBaseUrl } from "@/lib/mcp/oauth";

export async function GET() {
  const base = publicMcpBaseUrl();
  return NextResponse.json({
    issuer: base,
    authorization_endpoint: `${base}/api/mcp/oauth/authorize`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    revocation_endpoint: `${base}/api/mcp/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: MCP_SCOPES,
  }, { headers: { "cache-control": "public, max-age=300" } });
}
