/**
 * Recovers button taps that never arrived as a `messaging_postbacks` webhook.
 *
 * A tap on a follow-prompt or opening-DM button is also visible as the newest
 * inbound message of the conversation, whose text is the button's title. When
 * Meta does not deliver the postback webhook, this pass reads the conversation
 * list the Inbox already uses and enqueues the same job as the webhook path.
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
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import {
  getDMQueue, getRedisConnection, POSTBACK_JOB_NAME, RECENT_BUTTON_PROMPT_SECONDS, recentButtonPromptKey,
} from "@/lib/queue/client";
import { createInstagramContext, hasInstagramCredentials } from "@/lib/instagram/context";
import { iterateConversations, MetaApiError, RateLimitError } from "@/lib/meta/client";

export const BUTTON_TAP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const BUTTON_TAP_RECOVERED_MESSAGE = "Button taps recovered from conversations";
const SEEN_TTL_SECONDS = 48 * 60 * 60;
const PENDING_TTL_SECONDS = 60;
const CONVERSATION_SCAN_TIMEOUT_MS = 35_000;
const RECENT_SCAN_TIMEOUT_MS = 18_000;
const RATE_LIMIT_COOLDOWN_SECONDS = 5 * 60;
const RESOLVE_CLAIM = `
  if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
  if ARGV[2] == "0" then return redis.call("DEL", KEYS[1]) end
  redis.call("SET", KEYS[1], "1", "EX", ARGV[2])
  return 1
`;
const DEFAULT_FOLLOW_BUTTON_LABEL = "i'm following";

export type ButtonTapReconcileResult = { accounts: number; recovered: number; errors: number };

const normalize = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

type Candidate = { automationId: string; payload: string };

export async function reconcileButtonTaps(
  now = new Date(),
  mode: "recent" | "full" = "full",
): Promise<ButtonTapReconcileResult> {
  const result: ButtonTapReconcileResult = { accounts: 0, recovered: 0, errors: 0 };
  const since = new Date(now.getTime() - BUTTON_TAP_LOOKBACK_MS);
  const recentOnly = mode === "recent";
  const promptedSince = recentOnly ? new Date(now.getTime() - RECENT_BUTTON_PROMPT_SECONDS * 1000) : since;

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
    if (automation.workspaceId !== automation.instagramAccount.workspaceId) continue;
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
    const sentByAccount = {
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      status: "SENT" as const,
    };
    const pending = await prisma.dmLog.findFirst({
      where: { ...sentByAccount, automationId: { in: automationIds }, dmSentAt: { gte: promptedSince } },
      select: { id: true },
    });
    if (!pending && !recentOnly) continue;

    let recovered = 0;
    const redis = getRedisConnection();
    const rateLimitKey = `button_tap_scan_rate_limit:${account.id}`;
    try {
      if (!pending && !await redis.exists(recentButtonPromptKey(account.id))) continue;
      if (await redis.exists(rateLimitKey)) continue;
      const context = await createInstagramContext(account, `button-taps:${account.id}`);
      if (context.provider !== "META") continue;
      result.accounts += 1;
      const conversations = iterateConversations(
        context.accessToken, account.instagramId, {
          signal: AbortSignal.timeout(recentOnly ? RECENT_SCAN_TIMEOUT_MS : CONVERSATION_SCAN_TIMEOUT_MS),
          firstPageOnly: recentOnly,
        },
      );
      for await (const conversation of conversations) {
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
            ...sentByAccount,
            automationId: { in: candidates.map((candidate) => candidate.automationId) },
            commenterId: userId,
            dmSentAt: { gte: since, lte: sentAt },
          },
          orderBy: [{ dmSentAt: "desc" }, { id: "desc" }],
          select: { automationId: true },
        });
        const candidate = candidates.find((item) => item.automationId === prompted?.automationId);
        if (!candidate) continue;

        const seenKey = `button_tap_seen:${account.instagramId}:${message.id}`;
        const claim = randomUUID();
        if (await redis.set(seenKey, claim, "EX", PENDING_TTL_SECONDS, "NX") !== "OK") continue;

        try {
          await getDMQueue().add(
            POSTBACK_JOB_NAME,
            {
              instagramAccountId: account.instagramId,
              accountConnectionId: account.id,
              userId,
              payload: candidate.payload,
              mid: message.id,
              tapTimeSeconds: Math.floor(sentAt.getTime() / 1000),
            },
            // Same job identity as the webhook when Meta supplies the same mid.
            { jobId: `postback_${account.instagramId}_${userId}_${message.id.replace(/:/g, "_")}` }
          );
        } catch (error) {
          await redis.eval(RESOLVE_CLAIM, 1, seenKey, claim, 0).catch(() => {});
          throw error;
        }

        // If a process or Redis fails here, the short claim expires. The job
        // id and the DM worker's durable per-tap send claim cover a retry.
        if (await redis.eval(RESOLVE_CLAIM, 1, seenKey, claim, SEEN_TTL_SECONDS) === 1) recovered += 1;
      }
    } catch (error) {
      result.errors += 1;
      if (error instanceof RateLimitError ||
          (error instanceof MetaApiError && [32, 80001, 80002, 80006].includes(error.code))) {
        await redis.set(rateLimitKey, "1", "EX", RATE_LIMIT_COOLDOWN_SECONDS).catch(() => {});
      }
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
