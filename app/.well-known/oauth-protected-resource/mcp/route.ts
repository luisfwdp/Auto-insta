import { NextResponse } from "next/server";
import { MCP_SCOPES, publicMcpBaseUrl } from "@/lib/mcp/oauth";

export async function GET() {
  const base = publicMcpBaseUrl();
  return NextResponse.json({
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: `${base}/docs/mcp`,
  }, { headers: { "cache-control": "public, max-age=300" } });
}
