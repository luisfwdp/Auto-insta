/**
 * Recovers button taps that never arrived as a `messaging_postbacks` webhook.
 *
 * A tap on a follow-prompt or opening-DM button is also visible as the newest
 * inbound message of the conversation, whose text is the button's title. When
 * Meta does not deliver the postback webhook (for example while the messaging
 * permission only has Standard Access), nobody who taps the button ever gets
 * the link. This pass reads the conversation list the Inbox already uses and
 * enqueues the same job the webhook would have enqueued.
 *
 * It only acts for people this account prompted in the last 24 hours (the
 * messaging window), only when the newest message is theirs and matches the
 * button title exactly, and at most once per message. It never sends anything
 * itself: the worker's existing postback path keeps every follow, quota and
 * idempotency check.
 *
 * Conversations API (already used by the Inbox, no new permission):
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api
 */
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection, POSTBACK_JOB_NAME } from "@/lib/queue/client";
import { createInstagramContext, hasInstagramCredentials } from "@/lib/instagram/context";
import { getConversations } from "@/lib/instagram/read-inbox";

export const BUTTON_TAP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const BUTTON_TAP_RECOVERED_MESSAGE = "Button taps recovered from conversations";
const SEEN_TTL_SECONDS = 48 * 60 * 60;
const DEFAULT_FOLLOW_BUTTON_LABEL = "i'm following";

export type ButtonTapReconcileResult = { accounts: number; recovered: number; errors: number };

const normalize = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

type Candidate = { automationId: string; payload: string };

export async function reconcileButtonTaps(now = new Date()): Promise<ButtonTapReconcileResult> {
  const result: ButtonTapReconcileResult = { accounts: 0, recovered: 0, errors: 0 };
  const since = new Date(now.getTime() - BUTTON_TAP_LOOKBACK_MS);

  const automations = await prisma.automation.findMany({
    where: {
      isActive: true,
      OR: [{ requireFollow: true }, { openingDmEnabled: true }],
      instagramAccount: { provider: "META" },
    },
    select: {
      id: true,
      workspaceId: true,
      requireFollow: true,
      followPromptButtonLabel: true,
      openingDmEnabled: true,
      openingDmMessage: true,
      openingDmButtonLabel: true,
      instagramAccount: {
        select: {
          id: true, instagramId: true, accessToken: true, provider: true,
          workspaceId: true, zernioAccountId: true,
        },
      },
    },
  });

  const byAccount = new Map<string, typeof automations>();
  for (const automation of automations) {
    const list = byAccount.get(automation.instagramAccount.id) ?? [];
    list.push(automation);
    byAccount.set(automation.instagramAccount.id, list);
  }

  for (const group of byAccount.values()) {
    const account = group[0].instagramAccount;
    if (!hasInstagramCredentials(account)) continue;

    // Button title -> the campaigns on this account that send that button.
    const labels = new Map<string, Candidate[]>();
    const add = (label: string, candidate: Candidate) => {
      const key = normalize(label);
      if (!key) return;
      labels.set(key, [...(labels.get(key) ?? []), candidate]);
    };
    for (const automation of group) {
      const opening = automation.openingDmEnabled && Boolean(automation.openingDmMessage)
        && Boolean(automation.openingDmButtonLabel);
      if (opening) {
        add(automation.openingDmButtonLabel!, {
          automationId: automation.id,
          payload: `${automation.requireFollow ? "followcheck" : "reveal"}:${automation.id}:open`,
        });
      }
      if (automation.requireFollow) {
        add(automation.followPromptButtonLabel || DEFAULT_FOLLOW_BUTTON_LABEL, {
          automationId: automation.id,
          payload: `followcheck:${automation.id}`,
        });
      }
    }

    // No recent prompt from these campaigns means nothing can be waiting, so
    // the account costs no Graph API call.
    const automationIds = group.map((automation) => automation.id);
    const pending = await prisma.dmLog.findFirst({
      where: { automationId: { in: automationIds }, createdAt: { gte: since } },
      select: { id: true },
    });
    if (!pending) continue;

    result.accounts += 1;
    let recovered = 0;
    try {
      const context = await createInstagramContext(account, `button-taps:${account.id}`);
      const conversations = await getConversations({ context, igUserId: account.instagramId });

      for (const conversation of conversations) {
        const message = conversation.messages?.data?.[0];
        const userId = message?.from?.id;
        if (!message?.id || !userId || userId === account.instagramId) continue;
        const sentAt = message.created_time ? new Date(message.created_time) : null;
        if (!sentAt || Number.isNaN(sentAt.getTime()) || sentAt < since || sentAt > now) continue;
        const candidates = labels.get(normalize(message.message));
        if (!candidates?.length) continue;

        // The campaign that most recently contacted this person before the
        // tap decides which button it was. No prior contact, no action.
        const prompted = await prisma.dmLog.findFirst({
          where: {
            automationId: { in: candidates.map((candidate) => candidate.automationId) },
            commenterId: userId,
            createdAt: { gte: since, lte: sentAt },
          },
          orderBy: { createdAt: "desc" },
          select: { automationId: true },
        });
        const candidate = candidates.find((item) => item.automationId === prompted?.automationId);
        if (!candidate) continue;

        const first = await getRedisConnection().set(
          `button_tap_seen:${account.instagramId}:${message.id}`, "1", "EX", SEEN_TTL_SECONDS, "NX"
        );
        if (first !== "OK") continue;

        await getDMQueue().add(
          POSTBACK_JOB_NAME,
          {
            instagramAccountId: account.instagramId,
            accountConnectionId: account.id,
            userId,
            payload: candidate.payload,
            mid: message.id,
          },
          // Same id shape as the webhook path, so a postback webhook that does
          // arrive for the same message collapses into this job.
          { jobId: `postback_${account.instagramId}_${userId}_${message.id.replace(/:/g, "_")}` }
        );
        recovered += 1;
      }
    } catch {
      result.errors += 1;
    }

    if (recovered > 0) {
      result.recovered += recovered;
      // Counts only: no recipient id, name or message text.
      await prisma.operationalEvent
        .create({
          data: {
            workspaceId: group[0].workspaceId,
            source: "SYSTEM",
            level: "INFO",
            message: BUTTON_TAP_RECOVERED_MESSAGE,
            payload: { recovered },
          },
        })
        .catch(() => {});
    }
  }

  return result;
}
