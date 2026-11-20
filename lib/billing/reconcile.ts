import { prisma } from "@/lib/db/client";
import type { BillingCheckout, BillingSubscription, BillingEvent } from "@/app/generated/prisma/client";
import { createAsaasClient, AsaasError, type AsaasPaymentDTO, type AsaasSubscriptionDTO, type AsaasPaymentPageDTO } from "./asaas-client";
import { BillingError, getBillingProviderScope } from "./config";
import { derivePaidAccess, FinancialPolicyError, type FinancialPaymentRecord } from "./financial-policy";
import { claimBillingSync, assertBillingSyncLease, releaseBillingSync, renewBillingSync } from "./sync-lease";
import { claimBillingEvents, finishBillingEvent, renewBillingEvent } from "./inbox";

type Gateway = ReturnType<typeof createAsaasClient>;

/** Every provider key the lookup used, including links read by canonical GET. */
type ResourceKeys = { paymentIds: string[]; subscriptionIds: string[]; checkoutIds: string[] };

/** Unbound is retried by default: CRIA PING's own webhook may arrive before its link is saved.
 * "REJECTED" marks a link read that returned 404, keeping the provider code for operators.
 */
export class ResourceNotBoundError extends BillingError {
  constructor(readonly keys: ResourceKeys, code: "RESOURCE_NOT_BOUND" | "REJECTED" = "RESOURCE_NOT_BOUND") { super(code, 503); this.name = "ResourceNotBoundError"; }
}

/** Only a 404 means "not visible in this account"; 400/401/403 are our own faults and stay retry/DEAD. */
function isProviderNotFound(error: unknown) {
  return error instanceof AsaasError && error.code === "REJECTED" && error.httpStatus === 404;
}

// The Asaas account (and its account-wide webhook) is shared with other products.
// Their events are skipped as FOREIGN_RESOURCE, never DEAD, only after this grace.
export const FOREIGN_RESOURCE_GRACE_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;

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

/** A second complete pass detects same-count insertion/deletion between pages. */
async function stablePages(read: (options: { offset: number; limit: number }) => Promise<AsaasPaymentPageDTO>) {
  const first = await allPages(read), second = await allPages(read);
  const signature = (rows: AsaasPaymentDTO[]) => JSON.stringify(rows.slice().sort((a, b) => a.id.localeCompare(b.id)));
  if (signature(first) !== signature(second)) throw new BillingError("PAGINATION_INVALID");
  return second;
}

function assertSubscription(value: AsaasSubscriptionDTO, checkout: BillingCheckout) {
  if (value.valueCents !== checkout.amountCents || value.cycle !== "MONTHLY" || (value.checkoutSession && value.checkoutSession !== checkout.providerCheckoutId)) throw new BillingError("CANONICAL_LINK_MISMATCH");
}

async function syncCheckout(checkout: BillingCheckout, gateway: Gateway, token: string, bound?: BillingSubscription, affectedPaymentId?: string, terminal?: "CANCELED" | "EXPIRED", recoverExpiredOpen = false, heartbeat?: () => Promise<void>) {
  if (!checkout.providerCheckoutId) throw new BillingError("CHECKOUT_ID_UNKNOWN");
  const scope = getBillingProviderScope();
  const read = async <T>(request: () => Promise<T>) => {
    await heartbeat?.();
    await renewBillingSync(checkout.workspaceId, token);
    const value = await request();
    await heartbeat?.();
    await renewBillingSync(checkout.workspaceId, token);
    return value;
  };
  let canonicalSub: AsaasSubscriptionDTO, seed: AsaasPaymentDTO[] = [];
  if (bound) {
    canonicalSub = await read(() => gateway.getSubscription(bound.providerSubscriptionId));
    if (canonicalSub.customer !== bound.providerCustomerId) throw new BillingError("CANONICAL_LINK_MISMATCH");
  } else {
    seed = await stablePages(options => read(() => gateway.listPaymentsByCheckout(checkout.providerCheckoutId!, options)));
    if (!seed.length) {
      // A known OPEN link may recover without its terminal webhook. UNKNOWN
      // remains operator-gated; any recorded financial evidence blocks expiry.
      const evidence = await prisma.billingEvent.findFirst({ where: { ...scope, checkoutId: checkout.providerCheckoutId,
        OR: [{ eventType: "CHECKOUT_PAID" }, { eventType: { startsWith: "PAYMENT_" }, paymentId: { not: null } }] }, select: { id: true } });
      if (!evidence && checkout.status === "OPEN" && (terminal || recoverExpiredOpen) && Date.now() - checkout.createdAt.getTime() > 65 * 60_000) {
        await prisma.$transaction(async tx => {
          await assertBillingSyncLease(tx, checkout.workspaceId, token);
          await tx.billingCheckout.updateMany({ where: { id: checkout.id, workspaceId: checkout.workspaceId, status: "OPEN" }, data: { status: terminal ?? "EXPIRED" } });
        });
        return;
      }
      throw new BillingError("PAYMENT_NOT_VISIBLE", 503);
    }
    const ids = new Set(seed.map(payment => payment.subscription));
    if (ids.size !== 1 || !seed[0].subscription) throw new BillingError("CANONICAL_LINK_MISMATCH");
    canonicalSub = await read(() => gateway.getSubscription(seed[0].subscription!));
  }
  assertSubscription(canonicalSub, checkout);
  const canonical = await stablePages(options => read(() => gateway.listPaymentsBySubscription(canonicalSub.id, options)));
  // A canonical read that changed mid-pagination is retried, never resolved by
  // arrival order. Include checkout-indexed and affected (possibly deleted) IDs.
  const snapshots = [...seed, ...canonical];
  if (affectedPaymentId) snapshots.push(await read(() => gateway.getPayment(affectedPaymentId)));
  const known = bound ? await prisma.billingPayment.findMany({ where: { workspaceId: checkout.workspaceId, subscriptionId: bound.id, ...scope }, select: { providerPaymentId: true } }) : [];
  const present = new Set(snapshots.map(payment => payment.id));
  const missing = known.filter(row => !present.has(row.providerPaymentId));
  if (missing.length > 20) throw new BillingError("LEDGER_RECONCILIATION_REQUIRED");
  for (const row of missing) snapshots.push(await read(() => gateway.getPayment(row.providerPaymentId)));
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
    if (!promote && previousCurrent?.id !== sub?.id && (renewalStatus === "ACTIVE" || decision.status === "ACTIVE")) throw new BillingError("MULTIPLE_SUBSCRIPTIONS_REVIEW_REQUIRED");
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
export async function reconcileBillingResource(source: { paymentId?: string; subscriptionId?: string; checkoutId?: string; terminal?: "CANCELED" | "EXPIRED"; recoverExpiredOpen?: boolean }, provider?: Gateway, heartbeat?: () => Promise<void>) {
  const scope = getBillingProviderScope(), gateway = provider ?? createAsaasClient();
  const read = async <T>(request: () => Promise<T>) => { await heartbeat?.(); const value = await request(); await heartbeat?.(); return value; };
  let bound: BillingSubscription | null = null, checkout: BillingCheckout | null = null;
  const keys: ResourceKeys = { paymentIds: [], subscriptionIds: [], checkoutIds: [] };
  if (source.paymentId) {
    // Link-only read: another product's valid payment must not fail our strict
    // schema before we know it is not ours. syncCheckout re-reads it strictly.
    // A 404 hides the canonical links: classification then relies on the
    // webhook payload keys and the local checks, exactly as for any unbound event.
    const payment = await read(() => gateway.getPaymentLinks(source.paymentId!)).catch(error => {
      if (isProviderNotFound(error)) throw new ResourceNotBoundError({ ...keys, paymentIds: [source.paymentId!] }, "REJECTED");
      throw error;
    });
    keys.paymentIds.push(payment.id);
    if (payment.subscription) keys.subscriptionIds.push(payment.subscription);
    if (payment.checkoutSession) keys.checkoutIds.push(payment.checkoutSession);
    if (payment.subscription) bound = await prisma.billingSubscription.findUnique({ where: { environment_accountScope_providerSubscriptionId: { ...scope, providerSubscriptionId: payment.subscription } } });
    if (!bound && payment.checkoutSession) checkout = await prisma.billingCheckout.findUnique({ where: { environment_accountScope_providerCheckoutId: { ...scope, providerCheckoutId: payment.checkoutSession } } });
  } else if (source.subscriptionId) {
    keys.subscriptionIds.push(source.subscriptionId);
    bound = await prisma.billingSubscription.findUnique({ where: { environment_accountScope_providerSubscriptionId: { ...scope, providerSubscriptionId: source.subscriptionId } } });
    if (!bound) {
      const subscription = await read(() => gateway.getSubscriptionLinks(source.subscriptionId!)).catch(error => {
        if (isProviderNotFound(error)) throw new ResourceNotBoundError(keys, "REJECTED");
        throw error;
      });
      if (subscription.checkoutSession) keys.checkoutIds.push(subscription.checkoutSession);
      if (subscription.checkoutSession) checkout = await prisma.billingCheckout.findUnique({ where: { environment_accountScope_providerCheckoutId: { ...scope, providerCheckoutId: subscription.checkoutSession } } });
    }
  } else if (source.checkoutId) {
    keys.checkoutIds.push(source.checkoutId);
    checkout = await prisma.billingCheckout.findUnique({ where: { environment_accountScope_providerCheckoutId: { ...scope, providerCheckoutId: source.checkoutId } } });
  }
  if (bound) checkout = await prisma.billingCheckout.findFirst({ where: { id: bound.checkoutId, workspaceId: bound.workspaceId, ...scope } });
  if (!checkout) throw new ResourceNotBoundError(keys);
  if (!bound) bound = await prisma.billingSubscription.findFirst({ where: { checkoutId: checkout.id, workspaceId: checkout.workspaceId, ...scope } });
  const token = await claimBillingSync(checkout.workspaceId);
  try { await syncCheckout(checkout, gateway, token, bound ?? undefined, source.paymentId, source.terminal, source.recoverExpiredOpen, heartbeat); }
  finally { await releaseBillingSync(checkout.workspaceId, token).catch(() => {}); }
}

function sourceFor(event: BillingEvent) {
  if (event.eventType === "CHECKOUT_CREATED") return null;
  if (event.eventType.startsWith("PAYMENT_") && event.paymentId) return { paymentId: event.paymentId };
  if ((event.eventType.startsWith("SUBSCRIPTION_") || event.eventType === "INTERNAL_SUBSCRIPTION_RECONCILE") && event.subscriptionId) return { subscriptionId: event.subscriptionId };
  if ((event.eventType.startsWith("CHECKOUT_") || event.eventType === "INTERNAL_CHECKOUT_RECONCILE") && event.checkoutId) return { checkoutId: event.checkoutId,
    ...(event.eventType === "INTERNAL_CHECKOUT_RECONCILE" ? { recoverExpiredOpen: true } : {}),
    ...(event.eventType === "CHECKOUT_CANCELED" ? { terminal: "CANCELED" as const } : event.eventType === "CHECKOUT_EXPIRED" ? { terminal: "EXPIRED" as const } : {}) };
  return null;
}

/** Conservative classification of an unbound provider event as another product's.
 * It only skips a trigger: no ledger/access write happens here, and every CRIA PING
 * decision is still rebuilt from complete canonical reads by its own events/recovery.
 * Our intent row is committed BEFORE the only checkout POST (invariant 1), so an
 * event for our own checkout always has a local row: either with providerCheckoutId
 * (found by the key re-check) or still CREATING/UNKNOWN without it (blocks here).
 * The unresolved-intent query MUST precede the key re-check: an ID saved between
 * the reconcile lookup and this check is then still seen by the re-check.
 */
async function isForeignBillingResource(event: BillingEvent, keys: ResourceKeys, now = new Date()) {
  if (!/^(PAYMENT|SUBSCRIPTION|CHECKOUT)_/.test(event.eventType)) return false;
  if (now.getTime() - event.createdAt.getTime() < FOREIGN_RESOURCE_GRACE_MS) return false;
  const scope = getBillingProviderScope();
  const unresolved = await prisma.billingCheckout.findFirst({ where: { ...scope, providerCheckoutId: null, status: { in: ["CREATING", "UNKNOWN"] },
    createdAt: { lte: new Date(event.createdAt.getTime() + CLOCK_SKEW_MS) } }, select: { id: true } });
  if (unresolved) return false;
  const unique = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => !!value))];
  const paymentIds = unique([event.paymentId, ...keys.paymentIds]), subscriptionIds = unique([event.subscriptionId, ...keys.subscriptionIds]);
  const checkoutIds = unique([event.checkoutId, ...keys.checkoutIds]);
  const [payment, subscription, checkout] = await Promise.all([
    paymentIds.length ? prisma.billingPayment.findFirst({ where: { ...scope, providerPaymentId: { in: paymentIds } }, select: { id: true } }) : null,
    subscriptionIds.length ? prisma.billingSubscription.findFirst({ where: { ...scope, providerSubscriptionId: { in: subscriptionIds } }, select: { id: true } }) : null,
    checkoutIds.length ? prisma.billingCheckout.findFirst({ where: { ...scope, providerCheckoutId: { in: checkoutIds } }, select: { id: true } }) : null,
  ]);
  return !payment && !subscription && !checkout;
}

export async function processBillingInbox(limit = 5, provider?: Gateway) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new BillingError("INVALID_REQUEST", 400);
  const gateway = provider ?? createAsaasClient();
  let processed = 0;
  // Claim just before processing: slow reads must not age the next job's lease.
  for (let index = 0; index < limit; index++) {
    const [event] = await claimBillingEvents(1);
    if (!event) break;
    const owned = await prisma.billingEvent.findFirst({ where: { id: event.id, ...getBillingProviderScope(), status: "PROCESSING", leaseToken: event.leaseToken, leaseUntil: { gt: new Date() } }, select: { id: true } });
    if (!owned) continue;
    try {
      const source = sourceFor(event);
      if (source) await reconcileBillingResource(source, gateway, async () => {
        if (!await renewBillingEvent(event.id, event.leaseToken!)) throw new BillingError("EVENT_LEASE_LOST", 503);
      });
      if (await finishBillingEvent(event.id, event.leaseToken!, "processed")) processed++;
    } catch (error) {
      // Counted as processed: the event is finished, and its fixed code is the audit trail.
      if (error instanceof ResourceNotBoundError && await isForeignBillingResource(event, error.keys).catch(() => false)) {
        if (await finishBillingEvent(event.id, event.leaseToken!, "ignored", "FOREIGN_RESOURCE")) processed++;
        continue;
      }
      const code = error instanceof BillingError || error instanceof AsaasError || error instanceof FinancialPolicyError ? error.code : "RECONCILIATION_UNAVAILABLE";
      await finishBillingEvent(event.id, event.leaseToken!, "retry", code);
    }
  }
  return { processed };
}

/** Webhooks remain primary; sparse recovery catches lost updates without re-POSTs. */
export async function enqueueBillingRecovery() {
  const scope = getBillingProviderScope(), now = new Date(), bucket = Math.floor(now.getTime() / (6 * 3600_000));
  const cutoff = new Date(now.getTime() - 6 * 3600_000);
  const cursorDue = { OR: [{ recoveryEnqueuedAt: null }, { recoveryEnqueuedAt: { lte: cutoff } }] };
  const orderBy = [{ recoveryEnqueuedAt: { sort: "asc" as const, nulls: "first" as const } }, { updatedAt: "asc" as const }, { id: "asc" as const }];
  const [subscriptions, checkouts] = await Promise.all([
    prisma.billingSubscription.findMany({ where: { ...scope, currentFor: { isNot: null }, updatedAt: { lt: cutoff }, AND: [cursorDue,
      { OR: [{ renewalStatus: "ACTIVE" }, { currentFor: { is: { paidThrough: { gt: now } } } }] }] }, take: 2, orderBy }),
    prisma.billingCheckout.findMany({ where: { ...scope, providerCheckoutId: { not: null }, updatedAt: { lt: cutoff }, AND: [cursorDue,
      { OR: [{ status: "OPEN" }, { status: "UNKNOWN", createdAt: { gt: new Date(now.getTime() - 7 * 86400_000) } }] }] }, take: 1, orderBy }),
  ]);
  // At most three recovery events per tick, below the inbox drain budget of five.
  // Advance a dedicated CAS cursor even on failures so older broken rows cannot
  // monopolize the sweep. The cursor and durable event commit atomically.
  return prisma.$transaction(async tx => {
    let count = 0;
    for (const sub of subscriptions) {
      const claimed = await tx.billingSubscription.updateMany({ where: { id: sub.id, workspaceId: sub.workspaceId, ...scope, updatedAt: sub.updatedAt, recoveryEnqueuedAt: sub.recoveryEnqueuedAt }, data: { recoveryEnqueuedAt: now } });
      if (claimed.count) count += (await tx.billingEvent.createMany({ skipDuplicates: true, data: [{ ...scope, eventId: `recovery-sub:${sub.id}:${bucket}`, eventType: "INTERNAL_SUBSCRIPTION_RECONCILE", subscriptionId: sub.providerSubscriptionId }] })).count;
    }
    for (const checkout of checkouts) {
      const claimed = await tx.billingCheckout.updateMany({ where: { id: checkout.id, workspaceId: checkout.workspaceId, ...scope, updatedAt: checkout.updatedAt, recoveryEnqueuedAt: checkout.recoveryEnqueuedAt }, data: { recoveryEnqueuedAt: now } });
      if (claimed.count) count += (await tx.billingEvent.createMany({ skipDuplicates: true, data: [{ ...scope, eventId: `recovery-checkout:${checkout.id}:${bucket}`, eventType: "INTERNAL_CHECKOUT_RECONCILE", checkoutId: checkout.providerCheckoutId }] })).count;
    }
    return { count };
  });
}
