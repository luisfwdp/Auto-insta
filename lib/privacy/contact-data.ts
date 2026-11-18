import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { hashRecipientId } from "@/lib/tracking/server";

/**
 * LGPD art. 18: access (II), portability (V) and deletion/anonymization (IV, VI)
 * for a contact — the person who commented or messaged a connected account.
 * Every query is scoped to the workspace acting as controller for that contact.
 */
export const ERASED_TEXT = "[removido a pedido do titular]";

export type ContactRef = { commenterId?: string; username?: string };

function normalizeUsername(username: string) {
  return username.trim().replace(/^@/, "").toLowerCase();
}

/** Resolve the Instagram-scoped IDs a request refers to, inside one workspace. */
export async function resolveContactIds(workspaceId: string, ref: ContactRef): Promise<string[]> {
  if (ref.commenterId) return [ref.commenterId];
  if (!ref.username) return [];
  const rows = await prisma.dmLog.findMany({
    where: { workspaceId, commenterName: { equals: normalizeUsername(ref.username), mode: "insensitive" } },
    select: { commenterId: true },
    distinct: ["commenterId"],
    take: 50,
  });
  return rows.map((row) => row.commenterId).filter((id) => !id.startsWith("erased:"));
}

function webhookMatch(workspaceId: string, contactId: string) {
  // Comments carry the person in changes[].value.from.id; DMs in messaging[].sender.id.
  return {
    workspaceId,
    OR: [
      { payload: { path: ["entry"], array_contains: [{ changes: [{ value: { from: { id: contactId } } }] }] } },
      { payload: { path: ["entry"], array_contains: [{ messaging: [{ sender: { id: contactId } }] }] } },
    ],
  };
}

export async function exportContactData(workspaceId: string, contactIds: string[]) {
  if (!contactIds.length) return { contactIds: [], interactions: [], linkClicks: [], storedWebhookEvents: 0 };
  const recipientHashes = contactIds.map(hashRecipientId);
  const [interactions, linkClicks, webhookCounts] = await Promise.all([
    prisma.dmLog.findMany({
      where: { workspaceId, commenterId: { in: contactIds } },
      orderBy: { createdAt: "asc" },
      select: {
        commenterId: true, commenterName: true, commentText: true, commentId: true,
        matchedKeyword: true, status: true, dmSentAt: true, publicReplySentAt: true, createdAt: true,
        automation: { select: { name: true } },
        instagramAccount: { select: { username: true } },
      },
    }),
    prisma.linkClick.findMany({
      where: { workspaceId, recipientHash: { in: recipientHashes } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, userAgent: true, referrer: true, trackedLink: { select: { destinationUrl: true } } },
    }),
    Promise.all(contactIds.map((id) => prisma.webhookEvent.count({ where: webhookMatch(workspaceId, id) }))),
  ]);
  return {
    contactIds,
    interactions,
    linkClicks,
    storedWebhookEvents: webhookCounts.reduce((total, count) => total + count, 0),
  };
}

/**
 * Removes what identifies the contact and keeps only what delivery idempotency
 * needs (the comment ID and status), so an erased person is never messaged again
 * for the same comment and no content about them remains.
 */
export async function eraseContactData(workspaceId: string, contactIds: string[], requestedByUserId: string) {
  if (!contactIds.length) return { interactions: 0, linkClicks: 0, webhookEvents: 0 };
  const recipientHashes = contactIds.map(hashRecipientId);

  const result = await prisma.$transaction(async (tx) => {
    let interactions = 0;
    let webhookEvents = 0;
    for (const contactId of contactIds) {
      const marker = `erased:${createHash("sha256").update(`${workspaceId}:${contactId}`).digest("hex").slice(0, 24)}`;
      const updated = await tx.dmLog.updateMany({
        where: { workspaceId, commenterId: contactId },
        data: { commenterId: marker, commenterName: null, commentText: ERASED_TEXT, errorMessage: null, publicReplyError: null },
      });
      interactions += updated.count;
      const removed = await tx.webhookEvent.deleteMany({ where: webhookMatch(workspaceId, contactId) });
      webhookEvents += removed.count;
    }
    const clicks = await tx.linkClick.updateMany({
      where: { workspaceId, recipientHash: { in: recipientHashes } },
      data: { recipientHash: null, ipHash: null, userAgent: null, referrer: null },
    });
    await tx.operationalEvent.create({
      data: {
        workspaceId,
        source: "SYSTEM",
        level: "INFO",
        message: "Contact data erased at the data subject's request",
        // Accountability record (LGPD art. 37) without the identifier itself.
        payload: { requestedByUserId, contacts: contactIds.length, interactions, linkClicks: clicks.count, webhookEvents },
      },
    });
    return { interactions, linkClicks: clicks.count, webhookEvents };
  });
  return result;
}
