import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/server";
import { buildInitialCampaignLinks } from "@/lib/campaigns/links";
import { prisma } from "@/lib/db/client";
import { generateReportShareSlug } from "@/lib/reports/share";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";

const objectiveSchema = z.enum(["SALES", "PLAYLIST", "EBOOK", "LEADS", "FOLLOWERS"]);

const draftInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    objective: objectiveSchema,
    instagram_account_id: z.string().min(1),
    post_id: z.string().trim().min(1).optional(),
    post_url: z.string().url().optional(),
    match_any_post: z.boolean().default(false),
    keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
    dm_message: z.string().trim().min(1).max(1000),
    public_reply: z.string().trim().max(1000).optional(),
    destination_url: z.string().url().optional(),
    link_button_label: z.string().trim().max(20).optional(),
    require_follow: z.boolean().default(false),
    follow_prompt: z.string().trim().max(1000).optional(),
    follow_button_label: z.string().trim().max(20).optional(),
  })
  .refine((value) => value.match_any_post || Boolean(value.post_id), {
    message: "Provide post_id or set match_any_post",
    path: ["post_id"],
  })
  .refine(
    (value) =>
      !value.require_follow ||
      (Boolean(value.follow_prompt) && Boolean(value.follow_button_label)),
    {
      message: "Follow-gated drafts need prompt and button label",
      path: ["follow_prompt"],
    }
  );

export type CampaignDraftInput = z.infer<typeof draftInputSchema>;

export type McpCampaignService = {
  listAccounts(): Promise<unknown>;
  listCampaigns(): Promise<unknown>;
  createDraft(input: CampaignDraftInput): Promise<unknown>;
  previewDraft(id: string): Promise<unknown>;
  prepareActivation(id: string): Promise<unknown>;
};

function configuredWorkspaceId() {
  const workspaceId = process.env.PINGCHAT_MCP_WORKSPACE_ID?.trim();
  if (!workspaceId) {
    throw new Error("PINGCHAT_MCP_WORKSPACE_ID is required for campaign tools");
  }
  return workspaceId;
}

export function createPrismaMcpCampaignService(): McpCampaignService {
  const workspaceId = configuredWorkspaceId();

  async function findDraft(id: string) {
    const draft = await prisma.automation.findFirst({
      where: { id, workspaceId, isActive: false },
      include: {
        instagramAccount: { select: { id: true, username: true } },
        trackedLinks: { orderBy: TRACKED_LINK_ORDER },
      },
    });
    if (!draft) throw new Error("Draft not found in the authorized workspace");
    return draft;
  }

  return {
    listAccounts() {
      return prisma.instagramAccount.findMany({
        where: { workspaceId },
        select: {
          id: true,
          username: true,
          name: true,
          provider: true,
          webhookSubscribed: true,
          connectedAt: true,
        },
        orderBy: { connectedAt: "desc" },
      });
    },
    listCampaigns() {
      return prisma.automation.findMany({
        where: { workspaceId },
        select: {
          id: true,
          name: true,
          goal: true,
          isActive: true,
          keywords: true,
          postId: true,
          postUrl: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    },
    async createDraft(input) {
      const account = await prisma.instagramAccount.findFirst({
        where: { id: input.instagram_account_id, workspaceId },
        select: { id: true },
      });
      if (!account) throw new Error("Instagram account not found in the authorized workspace");

      const publicReplies = input.public_reply ? [input.public_reply] : [];
      const links = buildInitialCampaignLinks({
        workspaceId,
        primaryUrl: input.destination_url,
      });
      const draft = await prisma.automation.create({
        data: {
          workspaceId,
          instagramAccountId: account.id,
          name: input.name,
          goal: input.objective,
          postId: input.match_any_post ? null : input.post_id,
          postUrl: input.match_any_post ? null : input.post_url,
          matchAnyPost: input.match_any_post,
          keywords: [...new Set(input.keywords.map((value) => value.toLocaleUpperCase("pt-BR")))],
          dmMessage: input.dm_message,
          linkButtonLabel: input.link_button_label || null,
          requireFollow: input.require_follow,
          followPromptMessage: input.require_follow ? input.follow_prompt : null,
          followPromptButtonLabel: input.require_follow ? input.follow_button_label : null,
          publicReplyEnabled: publicReplies.length > 0,
          publicReplyMessage: publicReplies[0] ?? null,
          publicReplyMessages: publicReplies,
          isActive: false,
          reportShareSlug: generateReportShareSlug(),
          ...(links.length > 0 ? { trackedLinks: { create: links } } : {}),
        },
        select: { id: true, name: true, isActive: true, createdAt: true },
      });
      return { ...draft, status: "DRAFT" };
    },
    async previewDraft(id) {
      const draft = await findDraft(id);
      return {
        id: draft.id,
        status: "DRAFT",
        name: draft.name,
        objective: draft.goal,
        account: draft.instagramAccount,
        trigger: {
          postId: draft.postId,
          postUrl: draft.postUrl,
          matchAnyPost: draft.matchAnyPost,
          keywords: draft.keywords,
        },
        delivery: {
          dmMessage: draft.dmMessage,
          publicReplies: draft.publicReplyMessages,
          requireFollow: draft.requireFollow,
          followPrompt: draft.followPromptMessage,
        },
        links: draft.trackedLinks.map((link) => ({
          label: link.label,
          destinationUrl: link.destinationUrl,
        })),
        impact: { activatesForFutureEvents: true, sendsImmediately: false },
      };
    },
    async prepareActivation(id) {
      const draft = await findDraft(id);
      const baseUrl = (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
      return {
        draftId: draft.id,
        status: "AWAITING_HUMAN_APPROVAL",
        approvalUrl: `${baseUrl}/campaigns/${draft.id}/edit`,
        instructions: "Review the preview, then activate the campaign in PING CHAT. MCP cannot bypass human approval.",
        sendsImmediately: false,
      };
    },
  };
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

export function registerCampaignTools(server: McpServer, service: McpCampaignService) {
  server.registerTool(
    "get_campaign_capabilities",
    { description: "Describe safe PING CHAT campaign capabilities and approval limits" },
    async () =>
      result({
        objectives: objectiveSchema.options,
        draftPersistence: true,
        humanApprovalRequired: true,
        immediateDmSending: false,
        maxKeywords: 10,
      })
  );
  server.registerTool(
    "list_instagram_accounts",
    { description: "List Instagram accounts in the pre-authorized workspace" },
    async () => result(await service.listAccounts())
  );
  server.registerTool(
    "list_campaigns",
    { description: "List campaigns and drafts in the pre-authorized workspace" },
    async () => result(await service.listCampaigns())
  );
  server.registerTool(
    "create_campaign_draft",
    {
      description: "Persist an inactive campaign draft. This never sends messages or activates the campaign.",
      inputSchema: draftInputSchema,
    },
    async (input) => result(await service.createDraft(input))
  );
  server.registerTool(
    "preview_campaign_draft",
    {
      description: "Return the canonical preview and impact of an inactive draft",
      inputSchema: z.object({ draft_id: z.string().min(1) }),
    },
    async ({ draft_id }) => result(await service.previewDraft(draft_id))
  );
  server.registerTool(
    "prepare_campaign_activation",
    {
      description: "Return a PING CHAT approval URL. This tool never activates a campaign.",
      inputSchema: z.object({ draft_id: z.string().min(1) }),
    },
    async ({ draft_id }) => result(await service.prepareActivation(draft_id))
  );
}
