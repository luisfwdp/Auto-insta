import { prisma } from '@/lib/db/client';
import { getDMQueue, MESSAGE_JOB_NAME, POSTBACK_JOB_NAME } from '@/lib/queue/client';
import { messageJobId } from '@/lib/queue/message-job-id';
import { parseCommentEvents, parseMessageEvents, parsePostbackEvents, parseReadEvents } from '@/lib/meta/webhook';
import type { Prisma, InstagramProvider } from '@/app/generated/prisma/client';
import { recordUnmatchedWebhook, recordUnsupportedWebhookObject } from './webhook-diagnostics';

const OPENING_DM_READ_FALLBACK_DELAY_MS = 5 * 60 * 1000;
type InstagramPayload = Parameters<typeof parseCommentEvents>[0];

// Keep the fields needed by contact erasure, delivery counts and ad reconciliation.
// Message text and attachment URLs are only needed while processing the event.
function webhookMetadata(entries: InstagramPayload['entry']): Prisma.InputJsonObject {
  return {
    object: 'instagram',
    entry: entries.map((entry) => ({
      id: entry.id,
      ...(Array.isArray(entry.changes) && { changes: entry.changes.map((change) => {
        const isComment = change?.field === 'comments';
        const value: Prisma.InputJsonObject = {
          ...(typeof change?.value?.from?.id === 'string' && { from: { id: change.value.from.id } }),
          ...(isComment &&
            typeof change.value?.media?.id === 'string' &&
            typeof change.value.media.original_media_id === 'string' && {
              media: { id: change.value.media.id, original_media_id: change.value.media.original_media_id },
            }),
        };
        return { ...(isComment && { field: 'comments' }), value };
      }) }),
      ...(Array.isArray(entry.messaging) && { messaging: entry.messaging.map((event) => (
        typeof event?.sender?.id === 'string' ? { sender: { id: event.sender.id } } : {}
      )) }),
    })),
  };
}

export async function processInstagramWebhook({ payload: incoming, provider, workspaceId }: {
  payload: InstagramPayload; provider: InstagramProvider; workspaceId?: string;
}) {
  if (incoming.object !== 'instagram' || !Array.isArray(incoming.entry)) {
    await recordUnsupportedWebhookObject({ provider, object: incoming.object, entries: incoming.entry });
    return;
  }
  const accounts = await prisma.instagramAccount.findMany({
    where: { instagramId: { in: incoming.entry.map(e => e.id) }, provider, ...(workspaceId ? { workspaceId } : {}) },
    select: { id: true, instagramId: true, workspaceId: true },
  });
  const accountMap = new Map(accounts.map(a => [a.instagramId, a]));
  const allowed = new Set(accountMap.keys());
  const payload = { ...incoming, entry: incoming.entry.filter(e => allowed.has(e.id)) };
  const diagnostic = {
    provider,
    incoming,
    unmatched: incoming.entry.filter(e => !allowed.has(e.id)),
  };
  if (!payload.entry.length) {
    await recordUnmatchedWebhook(diagnostic);
    return;
  }
  const entriesByWorkspace = new Map<string, typeof payload.entry>();
  for (const entry of payload.entry) {
    const account = accountMap.get(entry.id);
    if (!account) continue;
    const entries = entriesByWorkspace.get(account.workspaceId) ?? [];
    entries.push(entry);
    entriesByWorkspace.set(account.workspaceId, entries);
  }
  const webhookEvents = await Promise.all(
    [...entriesByWorkspace.entries()].map(([eventWorkspaceId, entries]) =>
      prisma.webhookEvent.create({
        data: {
          object: 'instagram',
          payload: webhookMetadata(entries),
          workspaceId: eventWorkspaceId,
          status: "PENDING",
        },
        select: { id: true },
      })
    )
  );
  const webhookEventIds = webhookEvents.map((event) => event.id);

  try {
    const commentEvents = parseCommentEvents(
      payload as Parameters<typeof parseCommentEvents>[0]
    );
    const queue = getDMQueue();

    for (const event of commentEvents) {
      const account = accountMap.get(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        "process-comment",
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          originalMediaId: event.originalMediaId,
          source: "WEBHOOK",
        },
        {
          jobId: `comment_${event.instagramAccountId}_${event.commentId}`,
        }
      );
    }

    // Button taps from opening DMs → deliver the reveal message.
    const postbackEvents = parsePostbackEvents(
      payload as Parameters<typeof parsePostbackEvents>[0]
    );

    for (const event of postbackEvents) {
      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
          userId: event.userId,
          payload: event.payload,
          mid: event.mid,
          ...(event.tapTimeSeconds === undefined ? {} : { tapTimeSeconds: event.tapTimeSeconds }),
        },
        {
          // BullMQ forbids ":" in custom job ids, and the payload is
          // "reveal:<id>", so build with underscores and strip any colons.
          jobId: `postback_${event.instagramAccountId}_${event.userId}_${(
            event.mid ?? event.payload
          ).replace(/:/g, "_")}`,
        }
      );
    }

    // Inbound DMs → keyword-triggered autoreply.
    const messageEvents = parseMessageEvents(
      payload as Parameters<typeof parseMessageEvents>[0]
    );

    for (const event of messageEvents) {
      const account = accountMap.get(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        MESSAGE_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
          messageId: event.messageId,
          messageText: event.messageText,
          senderId: event.senderId,
          storyId: event.storyId,
          ...(event.messageSentAt === undefined ? {} : { messageSentAt: event.messageSentAt }),
        },
        {
          jobId: messageJobId(event.instagramAccountId, event.messageId),
        }
      );
    }

    // If a user reads the opening DM and never taps the button, deliver the
    // same next-step DM after five minutes. The worker no-ops this delayed job
    // if a real button tap has already delivered the reveal.
    const readEvents = parseReadEvents(
      payload as Parameters<typeof parseReadEvents>[0]
    );

    for (const event of readEvents) {
      const openingLogs = await prisma.dmLog.findMany({
        where: {
          commenterId: event.userId,
          status: "SENT",
          automation: {
            isActive: true,
            openingDmEnabled: true,
            instagramAccount: {
              instagramId: event.instagramAccountId,
            },
          },
        },
        select: {
          automation: {
            select: {
              id: true,
            },
          },
        },
      });

      const scheduledAutomationIds = new Set<string>();
      for (const log of openingLogs) {
        const automation = log.automation;
        if (scheduledAutomationIds.has(automation.id)) continue;
        scheduledAutomationIds.add(automation.id);

        await queue.add(
          POSTBACK_JOB_NAME,
          {
            instagramAccountId: event.instagramAccountId,
            accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
            userId: event.userId,
            payload: `reveal:${automation.id}`,
            fallback: true,
          },
          {
            delay: OPENING_DM_READ_FALLBACK_DELAY_MS,
            jobId: `read_fallback_${event.instagramAccountId}_${event.userId}_${automation.id}`,
          }
        );
      }
    }

    await prisma.webhookEvent.updateMany({
      where: { id: { in: webhookEventIds } },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });

    // Known-account delivery takes priority over best-effort diagnostics. Await
    // its database-bounded transaction so the request owns the whole lifecycle.
    await recordUnmatchedWebhook(diagnostic);
    return;
  } catch (error) {
    await prisma.webhookEvent.updateMany({
      where: { id: { in: webhookEventIds } },
      data: {
        status: "FAILED",
        errorMessage: "WEBHOOK_PROCESSING_FAILED",
        processedAt: new Date(),
      },
    });

    throw error;
  }
}
