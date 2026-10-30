import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";

import {
  createPingChatMcpHandler,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_SERVER_NAME,
} from "@/lib/mcp/server";

export const LOCAL_MCP_HOST = "127.0.0.1";
export const LOCAL_MCP_REQUEST_TIMEOUT_MS = 15_000;
export const LOCAL_MCP_HEADERS_TIMEOUT_MS = 5_000;
export const LOCAL_MCP_KEEP_ALIVE_TIMEOUT_MS = 5_000;

export type McpLogRecord = {
  level: "info" | "error";
  event: string;
  requestId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  errorName?: string;
};

export type McpLogger = (record: McpLogRecord) => void;

export type LocalMcpServerOptions = {
  logger?: McpLogger;
};

export type LocalMcpAddress = {
  host: typeof LOCAL_MCP_HOST;
  port: number;
  healthUrl: string;
  mcpUrl: string;
};

export type LocalMcpServer = {
  httpServer: Server;
  listen: (port?: number) => Promise<LocalMcpAddress>;
  close: () => Promise<void>;
};

function defaultLogger(record: McpLogRecord) {
  const output = JSON.stringify(record);
  if (record.level === "error") {
    console.error(output);
    return;
  }
  console.info(output);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function requestPath(request: IncomingMessage) {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

function closeHttpServer(server: Server) {
  if (!server.listening) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
    forceClose.unref();
    server.close((error) => {
      clearTimeout(forceClose);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

export function createLocalMcpServer(
  options: LocalMcpServerOptions = {}
): LocalMcpServer {
  const logger = options.logger ?? defaultLogger;
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const mcpHandler = createPingChatMcpHandler((error) => {
    logger({
      level: "error",
      event: "mcp_handler_error",
      errorName: error.name,
    });
  });
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
    onerror(error) {
      logger({
        level: "error",
        event: "mcp_adapter_error",
        errorName: error.name,
      });
    },
  });

  const httpServer = createServer(
    { maxHeaderSize: 16 * 1024 },
    (request, response) => {
      const requestId = randomUUID();
      const startedAt = Date.now();
      const path = requestPath(request);

      response.setHeader("x-request-id", requestId);
      response.once("finish", () => {
        logger({
          level: response.statusCode >= 500 ? "error" : "info",
          event: "http_request_completed",
          requestId,
          method: request.method,
          path,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
        });
      });

      if (!validateHost(request, response)) return;
      if (!validateOrigin(request, response)) return;
      if (!path) {
        sendJson(response, 400, { error: "invalid_request_url" });
        return;
      }

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: MCP_SERVER_NAME,
          transport: "streamable-http",
          exposure: "loopback-only",
          authentication: "not-configured",
        });
        return;
      }

      if (path === "/mcp") {
        response.setHeader("cache-control", "no-store");
        void nodeMcpHandler(request, response).catch((error: unknown) => {
          logger({
            level: "error",
            event: "mcp_request_failed",
            requestId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          if (!response.headersSent) {
            sendJson(response, 500, { error: "internal_server_error" });
          } else if (!response.writableEnded) {
            response.destroy();
          }
        });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    }
  );

  httpServer.requestTimeout = LOCAL_MCP_REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = LOCAL_MCP_HEADERS_TIMEOUT_MS;
  httpServer.keepAliveTimeout = LOCAL_MCP_KEEP_ALIVE_TIMEOUT_MS;
  httpServer.maxHeadersCount = 64;
  httpServer.maxRequestsPerSocket = 100;

  let closing: Promise<void> | undefined;

  return {
    httpServer,
    listen(port = 0) {
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        return Promise.reject(new Error("MCP port must be an integer from 0 to 65535"));
      }
      if (httpServer.listening) {
        return Promise.reject(new Error("MCP server is already listening"));
      }

      return new Promise<LocalMcpAddress>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        httpServer.once("error", onError);
        httpServer.listen({ host: LOCAL_MCP_HOST, port, exclusive: true }, () => {
          httpServer.off("error", onError);
          const address = httpServer.address() as AddressInfo;
          const baseUrl = `http://${LOCAL_MCP_HOST}:${address.port}`;
          resolve({
            host: LOCAL_MCP_HOST,
            port: address.port,
            healthUrl: `${baseUrl}/health`,
            mcpUrl: `${baseUrl}/mcp`,
          });
        });
      });
    },
    close() {
      if (!closing) {
        closing = Promise.all([
          mcpHandler.close(),
          closeHttpServer(httpServer),
        ]).then(() => undefined);
      }
      return closing;
    },
  };
}
