import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import type { InstagramProvider } from "@/app/generated/prisma/client";
import type { parseCommentEvents } from "@/lib/meta/webhook";

type InstagramPayload = Parameters<typeof parseCommentEvents>[0];
const INTERVAL_MS = 60_000;
// Fixed provider slots, never a map keyed by untrusted account IDs. This budget
// is per process instance; it is not a distributed rate limiter.
const lastRecorded: Record<InstagramProvider, number | null> = { META: null, ZERNIO: null };

/** Called only after the provider route verifies its webhook signature. */
export async function recordUnmatchedWebhook(args: {
  provider: InstagramProvider;
  incoming: InstagramPayload;
  unmatched: InstagramPayload["entry"];
}) {
  if (!args.unmatched.length) return;
  const now = Date.now();
  const last = lastRecorded[args.provider];
  if (last !== null && now - last < INTERVAL_MS) return;
  lastRecorded[args.provider] = now; // Reserve before awaiting, including on DB failure.

  const eventCounts = { comments: 0, liveComments: 0, messages: 0, postbacks: 0, reads: 0, reactions: 0, otherChanges: 0, otherMessaging: 0 };
  const entryIdHashes: string[] = [];
  for (const entry of args.unmatched) {
    if (entryIdHashes.length < 5) {
      const hash = createHash("sha256").update(entry.id).digest("hex");
      if (!entryIdHashes.includes(hash)) entryIdHashes.push(hash);
    }
    for (const change of entry.changes ?? []) {
      switch (change.field) {
        case "comments": eventCounts.comments += 1; break;
        case "live_comments": eventCounts.liveComments += 1; break;
        case "messages": eventCounts.messages += 1; break;
        case "messaging_postbacks": eventCounts.postbacks += 1; break;
        case "messaging_seen": eventCounts.reads += 1; break;
        case "message_reactions": eventCounts.reactions += 1; break;
        default: eventCounts.otherChanges += 1;
      }
    }
    for (const event of entry.messaging ?? []) {
      if (event.message) eventCounts.messages += 1;
      if (event.postback) eventCounts.postbacks += 1;
      if (event.read) eventCounts.reads += 1;
      if (event.reaction) eventCounts.reactions += 1;
      if (!event.message && !event.postback && !event.read && !event.reaction) eventCounts.otherMessaging += 1;
    }
  }
  try {
    await prisma.operationalEvent.create({ data: {
      workspaceId: null,
      source: "SYSTEM",
      level: "WARNING",
      message: "Signed Instagram webhook contained unmatched account entries",
      payload: {
        provider: args.provider,
        receivedEntries: args.incoming.entry.length,
        matchedEntries: args.incoming.entry.length - args.unmatched.length,
        unmatchedEntries: args.unmatched.length,
        entryIdHashes,
        eventCounts,
      },
    } });
  } catch {
    // Observability must not interrupt delivery for the matching accounts.
  }
}
