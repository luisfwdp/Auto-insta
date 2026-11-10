import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { McpPublishingService } from "@/lib/mcp/publishing-tools";
import {
  createLocalMcpServer,
  type LocalMcpAddress,
} from "@/lib/mcp/local-server";

const service: McpPublishingService = {
  listMedia: vi.fn(async () => [{ id: "asset_1", mediaType: "VIDEO" }]),
  listPublications: vi.fn(async () => [{ id: "publication_1", status: "SCHEDULED" }]),
  listBatches: vi.fn(async () => [{ id: "batch_1", status: "SCHEDULED" }]),
  createPublication: vi.fn(async (input) => ({
    id: "publication_2",
    status: input.publishNow || input.scheduledFor ? "SCHEDULED" : "DRAFT",
  })),
  createBatch: vi.fn(async (input) => ({
    id: "batch_2",
    status: "SCHEDULED",
    totalItems: input.items.length,
  })),
  manageBatch: vi.fn(async (id, action) => ({ id, action, status: "PAUSED" })),
};

const localServer = createLocalMcpServer({ publishingService: service });
let address: LocalMcpAddress;
let client: Client;

beforeAll(async () => {
  address = await localServer.listen();
  client = new Client({ name: "publishing-tools-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(address.mcpUrl)));
});

afterAll(async () => {
  await client.close();
  await localServer.close();
});

describe("PING CHAT MCP publishing tools", () => {
  it("exposes scheduling and Speed Post capabilities", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual([
      "get_publishing_capabilities",
      "list_publishing_media",
      "list_scheduled_publications",
      "list_speed_post_batches",
      "create_scheduled_publication",
      "create_speed_post_batch",
      "manage_speed_post_batch",
    ]);
    const capabilities = await client.callTool({ name: "get_publishing_capabilities" });
    expect(capabilities.structuredContent).toMatchObject({
      result: { maxBatchItems: 100, maxPostsPerDay: 25 },
    });
  });

  it("creates a scheduled Reel using ready media", async () => {
    const response = await client.callTool({
      name: "create_scheduled_publication",
      arguments: {
        instagramAccountId: "acct_1",
        type: "REEL",
        reelMode: "STANDARD",
        caption: "Novo Reel",
        assetIds: ["asset_1"],
        scheduledFor: "2027-01-10T15:00:00-03:00",
        publishNow: false,
        timezone: "America/Sao_Paulo",
      },
    });
    expect(response.structuredContent).toMatchObject({
      result: { id: "publication_2", status: "SCHEDULED" },
    });
    expect(service.createPublication).toHaveBeenCalledWith(
      expect.objectContaining({ type: "REEL", assetIds: ["asset_1"] })
    );
  });

  it("creates and manages a Speed Post batch", async () => {
    const response = await client.callTool({
      name: "create_speed_post_batch",
      arguments: {
        name: "Lote semanal",
        instagramAccountId: "acct_1",
        items: [{ assetId: "asset_1", caption: "Legenda individual" }],
        postsPerDay: 1,
        scheduleMode: "FIXED",
        orderMode: "SEQUENTIAL",
        timezone: "America/Sao_Paulo",
        timeSlots: ["10:00"],
        startsOn: "2027-01-10",
        defaultCaption: "Legenda padrão",
        reelMode: "STANDARD",
      },
    });
    expect(response.structuredContent).toMatchObject({
      result: { id: "batch_2", totalItems: 1 },
    });

    const paused = await client.callTool({
      name: "manage_speed_post_batch",
      arguments: { batchId: "batch_2", action: "pause" },
    });
    expect(paused.structuredContent).toMatchObject({
      result: { id: "batch_2", action: "pause" },
    });
  });

  it("rejects duplicate media before calling the service", async () => {
    const response = await client.callTool({
      name: "create_speed_post_batch",
      arguments: {
        name: "Duplicado",
        instagramAccountId: "acct_1",
        items: [{ assetId: "asset_1" }, { assetId: "asset_1" }],
        postsPerDay: 2,
        scheduleMode: "FIXED",
        orderMode: "SEQUENTIAL",
        timezone: "America/Sao_Paulo",
        timeSlots: ["10:00", "12:00"],
        startsOn: "2027-01-10",
        reelMode: "STANDARD",
      },
    });
    expect(response.isError).toBe(true);
    expect(service.createBatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "Duplicado" })
    );
  });
});
