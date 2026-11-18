import { prisma } from "@/lib/db/client";

/**
 * LGPD art. 15-16: personal data is kept only while it serves its purpose.
 * Retention is opt-in per data class. An unset, non-numeric or too-short value
 * disables that class, so a misconfiguration never deletes anything.
 */
export const MIN_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_ERASED_TEXT = "[removido pela política de retenção]";

export function retentionDays(value: string | undefined): number | null {
  if (!value) return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS) return null;
  return days;
}

export type RetentionResult = { webhookEvents: number; operationalEvents: number; contactTexts: number };

export async function applyRetention(now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<RetentionResult | null> {
  const webhookDays = retentionDays(env.RETENTION_WEBHOOK_EVENTS_DAYS);
  const operationalDays = retentionDays(env.RETENTION_OPERATIONAL_EVENTS_DAYS);
  const contactTextDays = retentionDays(env.RETENTION_CONTACT_TEXT_DAYS);
  if (webhookDays === null && operationalDays === null && contactTextDays === null) return null;

  const cutoff = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const result: RetentionResult = { webhookEvents: 0, operationalEvents: 0, contactTexts: 0 };

  if (webhookDays !== null) {
    // Never drop a payload that is still waiting to be processed.
    const removed = await prisma.webhookEvent.deleteMany({
      where: { createdAt: { lt: cutoff(webhookDays) }, status: { not: "PENDING" } },
    });
    result.webhookEvents = removed.count;
  }
  if (operationalDays !== null) {
    const removed = await prisma.operationalEvent.deleteMany({
      where: { createdAt: { lt: cutoff(operationalDays) } },
    });
    result.operationalEvents = removed.count;
  }
  if (contactTextDays !== null) {
    // Keep the row (delivery history and idempotency), drop what the contact wrote.
    const cleared = await prisma.dmLog.updateMany({
      where: {
        createdAt: { lt: cutoff(contactTextDays) },
        status: { not: "PENDING" },
        NOT: { commentText: RETENTION_ERASED_TEXT },
      },
      data: { commentText: RETENTION_ERASED_TEXT, commenterName: null },
    });
    result.contactTexts = cleared.count;
  }

  if (result.webhookEvents + result.operationalEvents + result.contactTexts > 0) {
    await prisma.operationalEvent.create({
      data: {
        source: "SYSTEM",
        level: "INFO",
        message: "Data retention applied",
        payload: { ...result, days: { webhookEvents: webhookDays, operationalEvents: operationalDays, contactText: contactTextDays } },
      },
    });
  }
  return result;
}
