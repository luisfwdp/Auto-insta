import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import {
  createPrismaMcpCampaignService,
  registerCampaignTools,
  type McpCampaignService,
} from "@/lib/mcp/campaign-tools";
import {
  createPrismaMcpPublishingService,
  registerPublishingTools,
  type McpPublishingService,
} from "@/lib/mcp/publishing-tools";

export const MCP_SERVER_NAME = "ping-chat";
export const MCP_SERVER_VERSION = "0.2.0";
export const MCP_MAX_REQUEST_BODY_BYTES = 256 * 1024;
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 128;

export function createPingChatMcpServer(
  service?: McpCampaignService,
  publishingService?: McpPublishingService
) {
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: { tools: {} },
      maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS,
    }
  );
  if (service || process.env.PINGCHAT_MCP_WORKSPACE_ID) {
    registerCampaignTools(server, service ?? createPrismaMcpCampaignService());
  }
  if (publishingService || process.env.PINGCHAT_MCP_WORKSPACE_ID) {
    registerPublishingTools(
      server,
      publishingService ?? createPrismaMcpPublishingService()
    );
  }
  return server;
}

export function createPingChatMcpHandler(
  onerror?: (error: Error) => void,
  service?: McpCampaignService,
  publishingService?: McpPublishingService
): McpHttpHandler {
  return createMcpHandler(() => createPingChatMcpServer(service, publishingService), {
    legacy: "stateless",
    responseMode: "auto",
    maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
    maxSubscriptions: 16,
    keepAliveMs: 15_000,
    onerror,
  });
}
