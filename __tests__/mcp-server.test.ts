import { request as httpRequest } from "node:http";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createLocalMcpServer,
  LOCAL_MCP_HEADERS_TIMEOUT_MS,
  LOCAL_MCP_HOST,
  LOCAL_MCP_KEEP_ALIVE_TIMEOUT_MS,
  LOCAL_MCP_REQUEST_TIMEOUT_MS,
  type LocalMcpAddress,
  type McpLogRecord,
} from "@/lib/mcp/local-server";
import { MCP_MAX_REQUEST_BODY_BYTES } from "@/lib/mcp/server";

const logs: McpLogRecord[] = [];
const localServer = createLocalMcpServer({ logger: (record) => logs.push(record) });
let address: LocalMcpAddress;

beforeAll(async () => {
  address = await localServer.listen();
});

afterAll(async () => {
  await localServer.close();
});

function rawRequest(headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: LOCAL_MCP_HOST,
        port: address.port,
        path: "/health",
        method: "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    request.once("error", reject);
    request.end();
  });
}

async function withClient(
  mode: "auto" | "legacy",
  callback: (client: Client) => Promise<void>
) {
  const client = new Client(
    { name: `ping-chat-test-${mode}`, version: "1.0.0" },
    { versionNegotiation: { mode } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(address.mcpUrl));
  await client.connect(transport);
  try {
    await callback(client);
  } finally {
    await client.close();
  }
}

describe("local MCP Streamable HTTP server", () => {
  it("exposes an explicit loopback-only health state", async () => {
    expect(address.host).toBe("127.0.0.1");
    expect(localServer.httpServer.address()).toMatchObject({
      address: "127.0.0.1",
    });

    const response = await fetch(address.healthUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      service: "ping-chat",
      transport: "streamable-http",
      exposure: "loopback-only",
      authentication: "not-configured",
    });
  });

  it("serves the modern protocol with no business tools", async () => {
    await withClient("auto", async (client) => {
      expect(client.getProtocolEra()).toBe("modern");
      await expect(client.listTools()).resolves.toMatchObject({ tools: [] });
    });
  });

  it("keeps stateless compatibility for 2025-era clients", async () => {
    await withClient("legacy", async (client) => {
      expect(client.getProtocolEra()).toBe("legacy");
      await expect(client.ping()).resolves.toEqual({});
      await expect(client.listTools()).resolves.toMatchObject({ tools: [] });
    });
  });

  it("rejects request bodies over the configured limit", async () => {
    const response = await fetch(address.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(MCP_MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
  });

  it("rejects non-JSON MCP posts", async () => {
    const response = await fetch(address.mcpUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json",
    });
    expect(response.status).toBe(415);
  });

  it("blocks non-local Host and Origin values", async () => {
    const badHost = await rawRequest({ host: "attacker.example" });
    expect(badHost.status).toBe(403);
    expect(JSON.parse(badHost.body)).toMatchObject({
      error: { code: -32000 },
    });

    const badOrigin = await rawRequest({
      host: `127.0.0.1:${address.port}`,
      origin: "https://attacker.example",
    });
    expect(badOrigin.status).toBe(403);
  });

  it("uses bounded HTTP settings and safe structured logs", async () => {
    expect(localServer.httpServer.requestTimeout).toBe(
      LOCAL_MCP_REQUEST_TIMEOUT_MS
    );
    expect(localServer.httpServer.headersTimeout).toBe(
      LOCAL_MCP_HEADERS_TIMEOUT_MS
    );
    expect(localServer.httpServer.keepAliveTimeout).toBe(
      LOCAL_MCP_KEEP_ALIVE_TIMEOUT_MS
    );

    await fetch(address.mcpUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer do-not-log-this-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ privateValue: "do-not-log-this-body" }),
    });

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain("do-not-log-this-token");
    expect(serializedLogs).not.toContain("do-not-log-this-body");
  });

  it("returns JSON 404s without reflecting the query string", async () => {
    const response = await fetch(
      `http://${LOCAL_MCP_HOST}:${address.port}/missing?secret=hidden`
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(JSON.stringify(logs)).not.toContain("secret=hidden");
  });
});
