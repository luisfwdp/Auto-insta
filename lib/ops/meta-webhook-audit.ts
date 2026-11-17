import { prisma } from "@/lib/db/client";
import { usesFacebookGraph, getInstagramLoginMode } from "@/lib/env";
import { createInstagramContext } from "@/lib/instagram/context";
import { getInstagramAccountWebhookFields } from "@/lib/meta/client";
import { getGrantedPermissions } from "@/lib/meta/facebook-login";

/** Fields the automations need Meta to deliver for every official account. */
export const REQUIRED_WEBHOOK_FIELDS = ["comments", "messages"] as const;
export const WEBHOOK_AUDIT_MESSAGE = "Meta webhook subscription audit";
const DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function safeError(error: unknown) {
  // Meta errors carry the request path, never the query string or token.
  return (error instanceof Error ? error.message : "Unknown error").slice(0, 300);
}

/**
 * Read-only evidence for "comments arrive but messages do not". For every
 * official account it records what Meta says is subscribed, what the token was
 * granted, and what the callback actually persisted. It changes nothing on Meta
 * and stores no token, sender or message content.
 */
export async function auditMetaWebhookSubscriptions(now = new Date()): Promise<number> {
  const accounts = await prisma.instagramAccount.findMany({
    where: { provider: "META" },
    select: {
      id: true, workspaceId: true, instagramId: true, username: true,
      accessToken: true, provider: true, zernioAccountId: true,
    },
  });
  const since = new Date(now.getTime() - DELIVERY_WINDOW_MS);
  let audited = 0;

  for (const account of accounts) {
    let subscribedFields: string[] | null = null;
    let grantedPermissions: string[] | null = null;
    let subscriptionError: string | null = null;
    try {
      const context = await createInstagramContext(account);
      if (context.provider !== "META") continue;
      try {
        subscribedFields = await getInstagramAccountWebhookFields(context.instagramId, context.accessToken);
      } catch (error) {
        subscriptionError = safeError(error);
      }
      // /me/permissions only exists on graph.facebook.com tokens.
      if (usesFacebookGraph()) {
        const granted = await getGrantedPermissions(context.accessToken);
        grantedPermissions = granted.length ? granted.sort() : null;
      }
    } catch (error) {
      subscriptionError = safeError(error);
    }

    // Counts only: no payload, sender or text leaves the database.
    const [received] = await prisma.$queryRaw<Array<{ comments: bigint; messaging: bigint }>>`
      SELECT
        count(*) FILTER (WHERE jsonb_path_exists("payload", '$.entry[*].changes[*] ? (@.field == "comments")')) AS "comments",
        count(*) FILTER (WHERE jsonb_path_exists("payload", '$.entry[*].messaging[*]')) AS "messaging"
      FROM "WebhookEvent"
      WHERE "workspaceId" = ${account.workspaceId}
        AND "createdAt" >= ${since}
        AND "payload" @> jsonb_build_object('entry', jsonb_build_array(jsonb_build_object('id', ${account.instagramId}::text)))
    `;

    const effectiveFields = subscribedFields;
    const missingFields = effectiveFields
      ? REQUIRED_WEBHOOK_FIELDS.filter((field) => !effectiveFields.includes(field))
      : null;
    const healthy = missingFields !== null && missingFields.length === 0;

    await prisma.operationalEvent.create({
      data: {
        workspaceId: account.workspaceId,
        source: "HEALTH",
        level: healthy ? "INFO" : "WARNING",
        message: WEBHOOK_AUDIT_MESSAGE,
        payload: {
          instagramAccountId: account.id,
          username: account.username,
          loginMode: getInstagramLoginMode(),
          subscribedFields,
          missingFields,
          subscriptionError,
          grantedPermissions,
          receivedLast7Days: {
            comments: Number(received?.comments ?? 0),
            messaging: Number(received?.messaging ?? 0),
          },
        },
      },
    });
    audited += 1;
  }
  return audited;
}
