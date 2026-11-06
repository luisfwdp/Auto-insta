import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { McpCampaignService } from "@/lib/mcp/campaign-tools";
import {
  createLocalMcpServer,
  type LocalMcpAddress,
} from "@/lib/mcp/local-server";

const service: McpCampaignService = {
  listAccounts: vi.fn(async () => [{ id: "acct_1", username: "creator" }]),
  listCampaigns: vi.fn(async () => [{ id: "campaign_1", isActive: false }]),
  createDraft: vi.fn(async (input) => ({ id: "draft_1", name: input.name, status: "DRAFT" })),
  previewDraft: vi.fn(async (id) => ({ id, status: "DRAFT", sendsImmediately: false })),
  prepareActivation: vi.fn(async (id) => ({ id, status: "AWAITING_HUMAN_APPROVAL" })),
};

const localServer = createLocalMcpServer({ campaignService: service });
let address: LocalMcpAddress;
let client: Client;

beforeAll(async () => {
  address = await localServer.listen();
  client = new Client({ name: "campaign-tools-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(address.mcpUrl)));
});

afterAll(async () => {
  await client.close();
  await localServer.close();
});

describe("PING CHAT MCP campaign tools", () => {
  it("exposes draft tools without any immediate-send tool", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual([
      "get_campaign_capabilities",
      "list_instagram_accounts",
      "list_campaigns",
      "create_campaign_draft",
      "preview_campaign_draft",
      "prepare_campaign_activation",
    ]);
    expect(names).not.toContain("send_dm");
    expect(names).not.toContain("activate_campaign");
  });

  it("persists an inactive draft through the workspace-scoped service", async () => {
    const response = await client.callTool({
      name: "create_campaign_draft",
      arguments: {
        name: "Playlist de pagode",
        objective: "PLAYLIST",
        instagram_account_id: "acct_1",
        post_id: "media_1",
        keywords: ["PAGODE"],
        dm_message: "Aqui está sua playlist, {username}",
        public_reply: "Te mandei no direct!",
        destination_url: "https://example.com/playlist",
        link_button_label: "Ouvir playlist",
        require_follow: true,
        follow_prompt: "Siga o perfil para continuar",
        follow_button_label: "Já sigo",
      },
    });
    expect(response.structuredContent).toMatchObject({
      result: { id: "draft_1", status: "DRAFT" },
    });
    expect(service.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ objective: "PLAYLIST", keywords: ["PAGODE"] })
    );
  });

  it("returns preview and an approval state without activating", async () => {
    const preview = await client.callTool({
      name: "preview_campaign_draft",
      arguments: { draft_id: "draft_1" },
    });
    expect(preview.structuredContent).toMatchObject({
      result: { status: "DRAFT", sendsImmediately: false },
    });

    const approval = await client.callTool({
      name: "prepare_campaign_activation",
      arguments: { draft_id: "draft_1" },
    });
    expect(approval.structuredContent).toMatchObject({
      result: { status: "AWAITING_HUMAN_APPROVAL" },
    });
  });

  it("redacts unexpected database errors", async () => {
    vi.mocked(service.listCampaigns).mockRejectedValueOnce(
      new Error("postgresql://user:secret@database.internal/private")
    );
    const response = await client.callTool({ name: "list_campaigns" });
    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          error: "PING CHAT could not complete this operation",
        }),
      },
    ]);
    expect(JSON.stringify(response)).not.toContain("database.internal");
    expect(JSON.stringify(response)).not.toContain("secret");
  });
});
