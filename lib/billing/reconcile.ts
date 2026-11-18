import { prisma } from "@/lib/db/client";
import type { BillingCheckout, BillingSubscription, BillingEvent } from "@/app/generated/prisma/client";
import { createAsaasClient, AsaasError, type AsaasPaymentDTO, type AsaasSubscriptionDTO, type AsaasPaymentPageDTO } from "./asaas-client";
import { BillingError, getBillingProviderScope } from "./config";
import { derivePaidAccess, FinancialPolicyError, type FinancialPaymentRecord } from "./financial-policy";
import { claimBillingSync, assertBillingSyncLease, releaseBillingSync } from "./sync-lease";
import { claimBillingEvents, finishBillingEvent } from "./inbox";

type Gateway = ReturnType<typeof createAsaasClient>;

/** All pages or no financial decision; never silently accept a truncated ledger. */
async function allPages(read: (options: { offset: number; limit: number }) => Promise<AsaasPaymentPageDTO>) {
  const result: AsaasPaymentDTO[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 0, offset = 0; page < 10; page++) {
    const next = await read({ offset, limit: 20 });
    if (next.offset !== offset || next.limit !== 20 || next.data.length > 20 || (total !== undefined && total !== next.totalCount)
      || offset + next.data.length > next.totalCount || next.hasMore !== (offset + next.data.length < next.totalCount)) throw new BillingError("PAGINATION_INVALID");
    total = next.totalCount;
    for (const payment of next.data) {
      if (seen.has(payment.id)) throw new BillingError("PAGINATION_INVALID");
      seen.add(payment.id);
    }
    result.push(...next.data);
    if (!next.hasMore) return result;
    if (!next.data.length) throw new BillingError("PAGINATION_INVALID");
    offset += next.data.length;
  }
  throw new BillingError("LEDGER_TOO_LARGE");
}

function assertSubscription(value: AsaasSubscriptionDTO, checkout: BillingCheckout) {
  if (value.valueCents !== checkout.amountCents || value.cycle !== "MONTHLY" || (value.checkoutSession && value.checkoutSession !== checkout.providerCheckoutId)) throw new BillingError("CANONICAL_LINK_MISMATCH");
}

async function syncCheckout(checkout: BillingCheckout, gateway: Gateway, token: string, bound?: BillingSubscription, affectedPaymentId?: string, terminal?: "CANCELED" | "EXPIRED") {
  if (!checkout.providerCheckoutId) throw new BillingError("CHECKOUT_ID_UNKNOWN");
  const scope = getBillingProviderScope();
  let canonicalSub: AsaasSubscriptionDTO, seed: AsaasPaymentDTO[] = [];
  if (bound) {
    canonicalSub = await gateway.getSubscription(bound.providerSubscriptionId);
    if (canonicalSub.customer !== bound.providerCustomerId) throw new BillingError("CANONICAL_LINK_MISMATCH");
  } else {
    seed = await allPages(options => gateway.listPaymentsByCheckout(checkout.providerCheckoutId!, options));
    if (!seed.length) {
      // Authenticated terminal events plus an empty canonical ledger can release
      // a link only after its validity window and an indexing grace. Clock alone
      // never resolves UNKNOWN creations or implies an unreceived payment.
      if (terminal && Date.now() - checkout.createdAt.getTime() > 65 * 60_000) {
        await prisma.$transaction(async tx => {
          await assertBillingSyncLease(tx, checkout.workspaceId, token);
          await tx.billingCheckout.updateMany({ where: { id: checkout.id, workspaceId: checkout.workspaceId, status: { in: ["OPEN", "UNKNOWN"] } }, data: { status: terminal } });
        });
        return;
      }
      throw new BillingError("PAYMENT_NOT_VISIBLE", 503);
    }
    const ids = new Set(seed.map(payment => payment.subscription));
    if (ids.size !== 1 || !seed[0].subscription) throw new BillingError("CANONICAL_LINK_MISMATCH");
    canonicalSub = await gateway.getSubscription(seed[0].subscription);
  }
  assertSubscription(canonicalSub, checkout);
  const canonical = await allPages(options => gateway.listPaymentsBySubscription(canonicalSub.id, options));
  // A canonical read that changed mid-pagination is retried, never resolved by
  // arrival order. Include checkout-indexed and affected (possibly deleted) IDs.
  const snapshots = [...seed, ...canonical];
  if (affectedPaymentId) snapshots.push(await gateway.getPayment(affectedPaymentId));
  const known = bound ? await prisma.billingPayment.findMany({ where: { workspaceId: checkout.workspaceId, subscriptionId: bound.id, ...scope }, select: { providerPaymentId: true } }) : [];
  const present = new Set(snapshots.map(payment => payment.id));
  const missing = known.filter(row => !present.has(row.providerPaymentId));
  if (missing.length > 20) throw new BillingError("LEDGER_RECONCILIATION_REQUIRED");
  for (const row of missing) snapshots.push(await gateway.getPayment(row.providerPaymentId));
  if (!snapshots.length) throw new BillingError("PAYMENT_NOT_VISIBLE", 503);

  const records: FinancialPaymentRecord[] = snapshots.map(payment => {
    if (payment.subscription !== canonicalSub.id || payment.customer !== canonicalSub.customer || (payment.checkoutSession && payment.checkoutSession !== checkout.providerCheckoutId)) throw new BillingError("CANONICAL_LINK_MISMATCH");
    return { id: payment.id, workspaceId: checkout.workspaceId, environment: scope.environment, accountId: scope.accountScope,
      customerId: payment.customer, subscriptionId: canonicalSub.id, amountCents: payment.valueCents, cycle: "MONTHLY", dueDate: payment.dueDate, status: payment.status, deleted: payment.deleted };
  });
  const decision = derivePaidAccess(records, { workspaceId: checkout.workspaceId, environment: scope.environment, accountId: scope.accountScope,
    customerId: canonicalSub.customer, subscriptionId: canonicalSub.id, planId: checkout.planId, amountCents: checkout.amountCents, cycle: "MONTHLY", billingAnchorDay: checkout.billingAnchorDay }, new Date());
  const renewalStatus = canonicalSub.deleted ? "CANCELED" : canonicalSub.status;

  await prisma.$transaction(async tx => {
    const billing = await assertBillingSyncLease(tx, checkout.workspaceId, token);
    let sub = await tx.billingSubscription.findUnique({ where: { environment_accountScope_providerSubscriptionId: { ...scope, providerSubscriptionId: canonicalSub.id } } });
    if (sub && (sub.workspaceId !== checkout.workspaceId || sub.checkoutId !== checkout.id || sub.providerCustomerId !== canonicalSub.customer || sub.amountCents !== checkout.amountCents || sub.planId !== checkout.planId)) throw new BillingError("CANONICAL_LINK_MISMATCH");
    const previousCurrent = billing.currentSubscriptionId ? await tx.billingSubscription.findFirstOrThrow({ where: { id: billing.currentSubscriptionId, workspaceId: checkout.workspaceId }, include: { checkout: true } }) : null;
    const promote = !previousCurrent || (!sub && previousCurrent.checkout.createdAt <= checkout.createdAt);
    if (promote && previousCurrent && previousCurrent.id !== sub?.id && (previousCurrent.renewalStatus === "ACTIVE" || (billing.paidThrough && billing.paidThrough > new Date()))) throw new BillingError("MULTIPLE_SUBSCRIPTIONS_REVIEW_REQUIRED");
    if (!sub) sub = await tx.billingSubscription.create({ data: { workspaceId: checkout.workspaceId, ...scope, providerSubscriptionId: canonicalSub.id, providerCustomerId: canonicalSub.customer, checkoutId: checkout.id, planId: checkout.planId, amountCents: checkout.amountCents, billingAnchorDay: checkout.billingAnchorDay, renewalStatus } });
    else await tx.billingSubscription.update({ where: { id: sub.id }, data: { renewalStatus } });
    // Equivalent CONFIRMED/RECEIVED snapshots have already been proven safe by
    // the policy. One upsert per ID prevents duplicated effects on the ledger.
    const unique = new Map(records.map(record => [record.id, record]));
    for (const record of unique.values()) {
      const key = { ...scope, providerPaymentId: record.id };
      const existing = await tx.billingPayment.findUnique({ where: { environment_accountScope_providerPaymentId: key } });
      if (existing && (existing.workspaceId !== checkout.workspaceId || existing.subscriptionId !== sub.id || existing.amountCents !== record.amountCents || existing.dueDate !== record.dueDate)) throw new BillingError("CANONICAL_INVOICE_CHANGED");
      await tx.billingPayment.upsert({ where: { environment_accountScope_providerPaymentId: key }, create: { ...key, workspaceId: checkout.workspaceId, subscriptionId: sub.id, amountCents: record.amountCents, dueDate: record.dueDate, status: record.status, deleted: record.deleted }, update: { status: record.status, deleted: record.deleted, syncedAt: new Date() } });
    }
    await tx.billingCheckout.updateMany({ where: { id: checkout.id, workspaceId: checkout.workspaceId }, data: { status: "COMPLETED", lastErrorCode: null } });
    if (billing.currentSubscriptionId === sub.id || promote) {
      const paidStatus = renewalStatus === "ACTIVE" ? "ACTIVE" : "CANCELED";
      const unpaidStatus = billing.trialEndsAt > new Date() ? "TRIALING" : renewalStatus === "ACTIVE" ? "PAST_DUE" : "CANCELED";
      await tx.workspaceBilling.update({ where: { workspaceId: checkout.workspaceId }, data: { currentSubscriptionId: sub.id, paidThrough: decision.paidThrough, planId: checkout.planId,
        status: billing.status === "SUSPENDED" ? "SUSPENDED" : decision.status === "ACTIVE" ? paidStatus : unpaidStatus } });
    }
  });
}

/** Resource IDs here come from the authenticated durable inbox, never an owner-supplied binding. */
export async function reconcileBillingResource(source: { paymentId?: string; subscriptionId?: string; checkoutId?: string; terminal?: "CANCELED" | "EXPIRED" }, provider?: Gateway) {
  const scope = getBillingProviderScope(), gateway = provider ?? createAsaasClient();
  let bound: BillingSubscription | null = null, checkout: BillingCheckout | null = null;
  if (source.paymentId) {
    const payment = await gateway.getPayment(source.paymentId);
    if (payment.subscription) bound = await prisma.billingSubscription.findUnique({ where: { environment_accountScope_providerSubscriptionId: { ...scope, providerSubscriptionId: payment.subscription } } });
    if (!bound && payment.checkoutSession) checkout = await prisma.billingCheckout.findUnique({ where: { environment_accountScope_providerCheckoutId: { ...scope, providerCheckoutId: payment.checkoutSession } } });
  } else if (source.subscriptionId) {
    bound = await prisma.billingSubscription.findUnique({ where: { environment_accountScope_providerSubscriptionId: { ...scope, providerSubscriptionId: source.subscriptionId } } });
    if (!bound) {
      const subscription = await gateway.getSubscription(source.subscriptionId);
      if (subscription.checkoutSession) checkout = await prisma.billingCheckout.findUnique({ where: { environment_accountScope_providerCheckoutId: { ...scope, providerCheckoutId: subscription.checkoutSession } } });
    }
  } else if (source.checkoutId) checkout = await prisma.billingCheckout.findUnique({ where: { environment_accountScope_providerCheckoutId: { ...scope, providerCheckoutId: source.checkoutId } } });
  if (bound) checkout = await prisma.billingCheckout.findFirst({ where: { id: bound.checkoutId, workspaceId: bound.workspaceId, ...scope } });
  if (!checkout) throw new BillingError("RESOURCE_NOT_BOUND", 503);
  if (!bound) bound = await prisma.billingSubscription.findFirst({ where: { checkoutId: checkout.id, workspaceId: checkout.workspaceId, ...scope } });
  const token = await claimBillingSync(checkout.workspaceId);
  try { await syncCheckout(checkout, gateway, token, bound ?? undefined, source.paymentId, source.terminal); }
  finally { await releaseBillingSync(checkout.workspaceId, token).catch(() => {}); }
}

function sourceFor(event: BillingEvent) {
  if (event.eventType === "CHECKOUT_CREATED") return null;
  if (event.eventType.startsWith("PAYMENT_") && event.paymentId) return { paymentId: event.paymentId };
  if ((event.eventType.startsWith("SUBSCRIPTION_") || event.eventType === "INTERNAL_SUBSCRIPTION_RECONCILE") && event.subscriptionId) return { subscriptionId: event.subscriptionId };
  if ((event.eventType.startsWith("CHECKOUT_") || event.eventType === "INTERNAL_CHECKOUT_RECONCILE") && event.checkoutId) return { checkoutId: event.checkoutId,
    ...(event.eventType === "CHECKOUT_CANCELED" ? { terminal: "CANCELED" as const } : event.eventType === "CHECKOUT_EXPIRED" ? { terminal: "EXPIRED" as const } : {}) };
  return null;
}

export async function processBillingInbox(limit = 5, provider?: Gateway) {
  const gateway = provider ?? createAsaasClient(), events = await claimBillingEvents(limit);
  let processed = 0;
  for (const event of events) {
    const owned = await prisma.billingEvent.findFirst({ where: { id: event.id, ...getBillingProviderScope(), status: "PROCESSING", leaseToken: event.leaseToken, leaseUntil: { gt: new Date() } }, select: { id: true } });
    if (!owned) continue;
    try {
      const source = sourceFor(event);
      if (source) await reconcileBillingResource(source, gateway);
      if (await finishBillingEvent(event.id, event.leaseToken!, "processed")) processed++;
    } catch (error) {
      const code = error instanceof BillingError || error instanceof AsaasError || error instanceof FinancialPolicyError ? error.code : "RECONCILIATION_UNAVAILABLE";
      await finishBillingEvent(event.id, event.leaseToken!, "retry", code);
    }
  }
  return { processed };
}

/** Webhooks remain primary; sparse recovery catches lost updates without re-POSTs. */
export async function enqueueBillingRecovery() {
  const scope = getBillingProviderScope(), now = new Date(), bucket = Math.floor(now.getTime() / (6 * 3600_000));
  const [subscriptions, checkouts] = await Promise.all([
    prisma.billingSubscription.findMany({ where: { ...scope, currentFor: { isNot: null }, updatedAt: { lt: new Date(now.getTime() - 6 * 3600_000) } }, take: 10, orderBy: { updatedAt: "asc" } }),
    prisma.billingCheckout.findMany({ where: { ...scope, providerCheckoutId: { not: null }, status: { in: ["OPEN", "UNKNOWN"] }, updatedAt: { lt: new Date(now.getTime() - 6 * 3600_000) } }, take: 10, orderBy: { updatedAt: "asc" } }),
  ]);
  return prisma.billingEvent.createMany({ skipDuplicates: true, data: [
    ...subscriptions.map(sub => ({ ...scope, eventId: `recovery-sub:${sub.id}:${bucket}`, eventType: "INTERNAL_SUBSCRIPTION_RECONCILE", subscriptionId: sub.providerSubscriptionId })),
    ...checkouts.map(checkout => ({ ...scope, eventId: `recovery-checkout:${checkout.id}:${bucket}`, eventType: "INTERNAL_CHECKOUT_RECONCILE", checkoutId: checkout.providerCheckoutId })),
  ] });
}
