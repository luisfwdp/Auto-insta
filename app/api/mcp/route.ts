import { NextRequest, NextResponse } from "next/server";

import { canManageWorkspace } from "@/lib/workspace-access";
import { createPrismaMcpCampaignService } from "@/lib/mcp/campaign-tools";
import { authenticateMcpBearer, publicMcpBaseUrl } from "@/lib/mcp/oauth";
import { createPrismaMcpPublishingService } from "@/lib/mcp/publishing-tools";
import { createPingChatMcpHandler, type McpToolPermissions } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  const metadata = `${publicMcpBaseUrl()}/.well-known/oauth-protected-resource/mcp`;
  return NextResponse.json(
    { error: "invalid_token" },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${metadata}"`,
      },
    }
  );
}

async function handle(request: NextRequest) {
  const auth = await authenticateMcpBearer(request.headers.get("authorization"));
  if (!auth) return unauthorized();
  const manager = canManageWorkspace(auth.role);
  const permissions: McpToolPermissions = {
    accountsRead: auth.scopes.has("accounts:read"),
    campaignsRead: auth.scopes.has("campaigns:read"),
    draftsWrite: manager && auth.scopes.has("drafts:write"),
    publishingRead: auth.scopes.has("publishing:read"),
    publishingWrite: manager && auth.scopes.has("publishing:write"),
  };
  const handler = createPingChatMcpHandler(
    undefined,
    createPrismaMcpCampaignService(auth.workspaceId),
    createPrismaMcpPublishingService(auth.workspaceId),
    permissions
  );
  try {
    return await handler.fetch(request);
  } finally {
    await handler.close();
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function DELETE(request: NextRequest) {
  return handle(request);
}
