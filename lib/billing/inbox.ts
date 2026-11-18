import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { Prisma, BillingEvent } from "@/app/generated/prisma/client";
import { BillingError, getBillingProviderScope } from "./config";

// Official payloads: docs.asaas.com/docs/{eventos-para-checkout,eventos-para-cobrancas,
// eventos-para-assinaturas}. Arrival order and callback URLs never establish payment.
const providerId = (prefix: string) => z.string().max(128).regex(new RegExp(`^${prefix}_[A-Za-z0-9_]+$`));
const envelope = z.object({ id: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/u), event: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]+$/) });
const payment = z.object({ id: providerId("pay"), subscription: providerId("sub").nullish(), checkoutSession: z.uuid().nullish() });
const subscription = z.object({ id: providerId("sub") });
const checkout = z.object({ id: z.uuid() });
const MAX_ATTEMPTS = 12;
const LEASE_MS = 180_000;

function minimalEvent(payload: unknown) {
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) throw new BillingError("INVALID_BILLING_EVENT", 400);
  const source = payload as Record<string, unknown>, value = parsed.data;
  let paymentId: string | null = null, subscriptionId: string | null = null, checkoutId: string | null = null;
  if (value.event.startsWith("PAYMENT_")) {
    const resource = payment.safeParse(source.payment);
    if (!resource.success) throw new BillingError("INVALID_BILLING_EVENT", 400);
    paymentId = resource.data.id; subscriptionId = resource.data.subscription ?? null; checkoutId = resource.data.checkoutSession ?? null;
  } else if (value.event.startsWith("SUBSCRIPTION_")) {
    const resource = subscription.safeParse(source.subscription);
    if (!resource.success) throw new BillingError("INVALID_BILLING_EVENT", 400);
    subscriptionId = resource.data.id;
  } else if (value.event.startsWith("CHECKOUT_")) {
    const resource = checkout.safeParse(source.checkout);
    if (!resource.success) throw new BillingError("INVALID_BILLING_EVENT", 400);
    checkoutId = resource.data.id;
  }
  return { eventId: value.id, eventType: value.event, paymentId, subscriptionId, checkoutId };
}

/** Authenticated callers only. Persist minimal IDs before acknowledging delivery.
 * Unique scope/account/event ID preserves retries, leases and already processed rows.
 */
export async function ingestBillingEvent(payload: unknown) {
  const scope = getBillingProviderScope(), minimal = minimalEvent(payload);
  const created = await prisma.billingEvent.createMany({ data: [{ ...scope, ...minimal }], skipDuplicates: true });
  const row = await prisma.billingEvent.findUniqueOrThrow({ where: { environment_accountScope_eventId: { ...scope, eventId: minimal.eventId } } });
  if (row.eventType !== minimal.eventType || row.paymentId !== minimal.paymentId || row.subscriptionId !== minimal.subscriptionId || row.checkoutId !== minimal.checkoutId) throw new BillingError("BILLING_EVENT_CONFLICT", 409);
  return { id: row.id, duplicate: created.count === 0 };
}

function eligible(now: Date): Prisma.BillingEventWhereInput {
  return { OR: [
    { status: { in: ["PENDING", "RETRY"] }, nextAttemptAt: { lte: now } },
    { status: "PROCESSING", OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
  ] };
}

function validTime(now: Date) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new BillingError("INVALID_REQUEST", 400);
}

/** CAS claims survive competing workers and recover crashed processing leases. */
export async function claimBillingEvents(limit = 10, now = new Date()): Promise<BillingEvent[]> {
  validTime(now);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new BillingError("INVALID_REQUEST", 400);
  const scope = getBillingProviderScope();
  const candidates = await prisma.billingEvent.findMany({ where: { ...scope, ...eligible(now) }, orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }], take: limit * 2 });
  const claimed: BillingEvent[] = [];
  for (const candidate of candidates) {
    const where = { id: candidate.id, ...scope, ...eligible(now), attempts: candidate.attempts };
    if (candidate.attempts >= MAX_ATTEMPTS) {
      await prisma.billingEvent.updateMany({ where, data: { status: "DEAD", leaseToken: null, leaseUntil: null, lastErrorCode: "ATTEMPTS_EXHAUSTED" } });
      continue;
    }
    const leaseToken = randomUUID();
    const updated = await prisma.billingEvent.updateMany({ where, data: { status: "PROCESSING", attempts: { increment: 1 }, leaseToken, leaseUntil: new Date(now.getTime() + LEASE_MS), lastErrorCode: null } });
    if (updated.count) {
      const row = await prisma.billingEvent.findFirst({ where: { id: candidate.id, ...scope, leaseToken, status: "PROCESSING" } });
      if (row) claimed.push(row);
    }
    if (claimed.length === limit) break;
  }
  return claimed;
}

/** Long canonical reads may extend only their own still-live inbox lease. */
export async function renewBillingEvent(id: string, token: string, now = new Date()) {
  validTime(now);
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(token).success) throw new BillingError("INVALID_REQUEST", 400);
  const updated = await prisma.billingEvent.updateMany({ where: { id, ...getBillingProviderScope(), status: "PROCESSING", leaseToken: token, leaseUntil: { gt: now } }, data: { leaseUntil: new Date(now.getTime() + LEASE_MS) } });
  return updated.count === 1;
}

/** A stale worker cannot finish, retry or discard a new owner's claim. */
export async function finishBillingEvent(id: string, token: string, outcome: "processed" | "retry" | "dead", errorCode?: string, now = new Date()) {
  validTime(now);
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(token).success || !["processed", "retry", "dead"].includes(outcome)) throw new BillingError("INVALID_REQUEST", 400);
  const scope = getBillingProviderScope();
  const where = { id, ...scope, status: "PROCESSING" as const, leaseToken: token, leaseUntil: { gt: now } };
  const row = await prisma.billingEvent.findFirst({ where });
  if (!row) return false;
  const code = errorCode && /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode) ? errorCode : "BILLING_PROCESSING_FAILED";
  const status = outcome === "processed" ? "PROCESSED" : outcome === "dead" || row.attempts >= MAX_ATTEMPTS ? "DEAD" : "RETRY";
  const delay = Math.min(3_600_000, 1000 * 2 ** Math.min(row.attempts - 1, 12));
  const updated = await prisma.billingEvent.updateMany({ where, data: { status, leaseToken: null, leaseUntil: null,
    lastErrorCode: status === "PROCESSED" ? null : code,
    ...(status === "RETRY" ? { nextAttemptAt: new Date(now.getTime() + delay) } : {}),
  } });
  return updated.count === 1;
}
