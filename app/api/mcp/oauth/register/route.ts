import { NextRequest, NextResponse } from "next/server";
import { dynamicClientSchema, registerMcpClient } from "@/lib/mcp/oauth";
import { checkMcpOAuthRateLimit } from "@/lib/api/auth-rate-limit";

export async function POST(request: NextRequest) {
  const limit = await checkMcpOAuthRateLimit({ headers: request.headers });
  if (!limit.allowed) {
    return NextResponse.json({ error: "slow_down" }, {
      status: 429,
      headers: { "retry-after": String(limit.retryAfter), "cache-control": "no-store" },
    });
  }
  const parsed = dynamicClientSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_client_metadata" }, { status: 400 });
  }
  const client = await registerMcpClient(parsed.data);
  return NextResponse.json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
  }, { status: 201, headers: { "cache-control": "no-store" } });
}
