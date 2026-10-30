import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

export const MCP_SERVER_NAME = "ping-chat";
export const MCP_SERVER_VERSION = "0.1.0";
export const MCP_MAX_REQUEST_BODY_BYTES = 256 * 1024;
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 128;

export function createPingChatMcpServer() {
  return new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: { tools: {} },
      maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS,
    }
  );
}

export function createPingChatMcpHandler(
  onerror?: (error: Error) => void
): McpHttpHandler {
  return createMcpHandler(() => createPingChatMcpServer(), {
    legacy: "stateless",
    responseMode: "auto",
    maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
    maxSubscriptions: 16,
    keepAliveMs: 15_000,
    onerror,
  });
}
