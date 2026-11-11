import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  authorizationRequestSchema,
  dynamicClientSchema,
  hashCredential,
  parseScopes,
  verifyPkce,
} from "@/lib/mcp/oauth";
import { createLocalMcpServer } from "@/lib/mcp/local-server";
import type { McpCampaignService } from "@/lib/mcp/campaign-tools";
import type { McpPublishingService } from "@/lib/mcp/publishing-tools";

describe("MCP OAuth security primitives", () => {
  it("validates S256 PKCE without accepting short or altered verifiers", () => {
    const verifier = "a-secure-verifier-with-at-least-forty-three-characters-123";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(`${verifier}x`, challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
  });

  it("allows only declared least-privilege scopes", () => {
    expect(parseScopes("accounts:read campaigns:read accounts:read")).toEqual([
      "accounts:read",
      "campaigns:read",
    ]);
    expect(() => parseScopes("admin:all")).toThrow("invalid_scope");
  });

  it("accepts HTTPS and localhost callback URIs but rejects public HTTP", () => {
    expect(dynamicClientSchema.safeParse({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    }).success).toBe(true);
    expect(dynamicClientSchema.safeParse({
      client_name: "Local test",
      redirect_uris: ["http://127.0.0.1:4567/callback"],
    }).success).toBe(true);
    expect(dynamicClientSchema.safeParse({
      client_name: "Unsafe",
      redirect_uris: ["http://attacker.example/callback"],
    }).success).toBe(false);
  });

  it("requires authorization code flow with S256 and a state value", () => {
    const base = {
      response_type: "code",
      client_id: "client_1",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      state: "opaque-state",
      scope: "accounts:read",
    };
    expect(authorizationRequestSchema.safeParse(base).success).toBe(true);
    expect(authorizationRequestSchema.safeParse({ ...base, code_challenge_method: "plain" }).success).toBe(false);
    expect(authorizationRequestSchema.safeParse({ ...base, state: "" }).success).toBe(false);
  });

  it("hashes bearer credentials deterministically without retaining plaintext", () => {
    const token = "pc_at_private-token-material";
    expect(hashCredential(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashCredential(token)).not.toContain(token);
  });
});

describe("MCP scope-filtered tool catalog", () => {
  it("does not advertise write tools to a read-only grant", async () => {
    const campaignService: McpCampaignService = {
      listAccounts: async () => [], listCampaigns: async () => [], createDraft: async () => ({}),
      previewDraft: async () => ({}), prepareActivation: async () => ({}),
    };
    const publishingService: McpPublishingService = {
      listMedia: async () => [], listPublications: async () => [], listBatches: async () => [],
      createPublication: async () => ({}), createBatch: async () => ({}), manageBatch: async () => ({}),
    };
    const local = createLocalMcpServer({
      campaignService,
      publishingService,
      permissions: {
        accountsRead: true, campaignsRead: true, draftsWrite: false,
        publishingRead: true, publishingWrite: false,
      },
    });
    const address = await local.listen();
    const client = new Client({ name: "scope-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(address.mcpUrl)));
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("list_campaigns");
      expect(names).toContain("list_scheduled_publications");
      expect(names).not.toContain("create_campaign_draft");
      expect(names).not.toContain("create_scheduled_publication");
      expect(names).not.toContain("manage_speed_post_batch");
    } finally {
      await client.close();
      await local.close();
    }
  });
});
