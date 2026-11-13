import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { checkManualDmRateLimit } from "@/lib/api/manual-dm-rate-limit";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import {
  getConversations,
  sendDirectMessage,
  MetaApiError,
} from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";

export interface ConversationListItem {
  id: string;
  detailsUnavailable?: boolean;
  contact: { id: string; username: string | null };
  updatedTime: string | null;
  lastMessage: {
    text: string;
    fromMe: boolean;
    createdTime: string | null;
  } | null;
}

export interface ConversationsResponse {
  conversations: ConversationListItem[];
  account: { id: string; username: string; instagramId: string };
}

async function recordManualDmAudit({
  workspaceId,
  userId,
  instagramAccountId,
  outcome,
  messageLength,
}: {
  workspaceId: string;
  userId: string;
  instagramAccountId: string;
  outcome: "SENT" | "FAILED" | "RATE_LIMITED";
  messageLength: number;
}) {
  await prisma.operationalEvent
    .create({
      data: {
        workspaceId,
        source: "SYSTEM",
        level: outcome === "SENT" ? "INFO" : "WARNING",
        message: `Manual Instagram DM ${outcome.toLowerCase()}`,
        payload: {
          userId,
          instagramAccountId,
          outcome,
          messageLength,
        },
      },
    })
    .catch(() => {
      console.error("[Conversations] Failed to record manual DM audit event");
    });
}

// List the account's DM conversations for the inbox.
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  try {
    const accessToken = await createInstagramContext(account);
    const raw = await getConversations({
      context: accessToken,
      igUserId: account.instagramId,
    });

    const conversations: ConversationListItem[] = raw.map((c) => {
      const participants = c.participants?.data ?? [];
      const contact =
        participants.find((p) => p.id !== account.instagramId) ?? null;
      const last = c.messages?.data?.[0] ?? null;

      return {
        id: c.id,
        detailsUnavailable: c.detailsUnavailable,
        contact: {
          id: contact?.id ?? "",
          username: contact?.username ?? null,
        },
        updatedTime: c.updated_time ?? null,
        lastMessage: last
          ? {
              text: last.message ?? "",
              fromMe: last.from?.id === account.instagramId,
              createdTime: last.created_time ?? null,
            }
          : null,
      };
    });

    const data: ConversationsResponse = {
      conversations,
      account: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
      },
    };
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[Conversations] Error:", err);
    const message =
      err instanceof MetaApiError
        ? err.message
        : "Failed to load conversations";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

// Send a direct message reply.
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only workspace owners and admins can send messages." },
      { status: 403 }
    );
  }

  let body: {
    instagramAccountId?: string;
    recipientId?: string;
    text?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  const text = body.text?.trim();
  if (!body.recipientId || !text) {
    return NextResponse.json(
      { success: false, error: "A recipient and message are required." },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    body.instagramAccountId ?? null
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  let rateLimit: Awaited<ReturnType<typeof checkManualDmRateLimit>>;
  try {
    rateLimit = await checkManualDmRateLimit({
      workspaceId: context.workspaceId,
      instagramAccountId: account.id,
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "Message service temporarily unavailable." },
      { status: 503 }
    );
  }
  if (!rateLimit.allowed) {
    await recordManualDmAudit({
      workspaceId: context.workspaceId,
      userId: context.userId,
      instagramAccountId: account.id,
      outcome: "RATE_LIMITED",
      messageLength: text.length,
    });
    return NextResponse.json(
      { success: false, error: "Too many messages. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfter) },
      }
    );
  }

  try {
    const accessToken = await createInstagramContext(account);
    const result = await sendDirectMessage({
      context: accessToken,
      instagramAccountId: account.instagramId,
      userId: body.recipientId,
      message: text,
    });
    await recordManualDmAudit({
      workspaceId: context.workspaceId,
      userId: context.userId,
      instagramAccountId: account.id,
      outcome: "SENT",
      messageLength: text.length,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error("[Conversations] Send error:", err);
    // Surface Meta's own message — the common case is the 24-hour messaging
    // window having closed, which the user needs to see explicitly.
    const message =
      err instanceof MetaApiError ? err.message : "Failed to send message";
    await recordManualDmAudit({
      workspaceId: context.workspaceId,
      userId: context.userId,
      instagramAccountId: account.id,
      outcome: "FAILED",
      messageLength: text.length,
    });
    return NextResponse.json(
      { success: false, error: message },
      { status: 502 }
    );
  }
}
