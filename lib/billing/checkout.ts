import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { encryptToken, decryptToken } from "@/lib/meta/oauth";
import type { BillingCheckout } from "@/app/generated/prisma/client";
import { createAsaasClient, AsaasError, getAsaasCheckoutOrigin } from "./asaas-client";
import { BILLING_PLANS, BILLING_PLAN_IDS } from "./catalog";
import { BillingError, getBillingProviderScope, saoPauloDate } from "./config";
import { isBillingEnabled } from "./trial";
import { isBillingSalesEnabled } from "./sales";
import { createBillingGateway } from "./gateway";
import { reconcileBillingResource } from "./reconcile";

export const checkoutRequest = z.object({
  requestId: z.uuid(), planId: z.enum(BILLING_PLAN_IDS),
  expectedAmountCents: z.number().int().positive(),
  // A customer may voluntarily subscribe early; never silently end a free trial.
  acceptImmediateCharge: z.literal(true),
}).strict();
export type CheckoutRequest = z.infer<typeof checkoutRequest>;

function checkoutDTO(row: BillingCheckout) {
  return { id: row.id, status: row.status, planId: row.planId, amountCents: row.amountCents,
    url: row.status === "OPEN" && row.checkoutUrlCiphertext ? decryptToken(row.checkoutUrlCiphertext) : null };
}

/** Durable intent BEFORE the only provider POST; no network inside a DB lock. */
export async function requestCheckout(workspaceId: string, value: CheckoutRequest, provider?: ReturnType<typeof createAsaasClient>) {
  if (!isBillingEnabled()) throw new BillingError("BILLING_DISABLED", 404);
  if (!isBillingSalesEnabled()) throw new BillingError("BILLING_SALES_DISABLED", 503);
  const parsed = checkoutRequest.safeParse(value);
  if (!parsed.success) throw new BillingError("INVALID_REQUEST", 400);
  const input = parsed.data, plan = BILLING_PLANS[input.planId], scope = getBillingProviderScope();
  if (input.expectedAmountCents !== plan.amountCents) throw new BillingError("OFFER_CHANGED");
  const gateway = provider ?? createBillingGateway();
  const origin = getAsaasCheckoutOrigin();
  if (process.env.PULSO_CHECKOUT_ENABLED === "true" && !origin.startsWith("https://")) throw new BillingError("BILLING_CONFIGURATION", 503);
  // Validate encryption configuration before any financial mutation could happen.
  encryptToken("billing-readiness");
  const now = new Date();
  const reservation = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "workspaceId" FROM "WorkspaceBilling" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
    const billing = await tx.workspaceBilling.findUnique({ where: { workspaceId }, include: { currentSubscription: true } });
    if (!billing) throw new BillingError("TRIAL_NOT_STARTED");
    if (billing.status === "SUSPENDED") throw new BillingError("BILLING_SUSPENDED", 403);
    const previous = await tx.billingCheckout.findUnique({ where: { workspaceId_requestId: { workspaceId, requestId: input.requestId } } });
    if (previous) {
      if (previous.planId !== input.planId || previous.amountCents !== plan.amountCents || previous.environment !== scope.environment || previous.accountScope !== scope.accountScope) throw new BillingError("REQUEST_CONFLICT");
      return { row: previous, created: false };
    }
    if (billing.syncLeaseUntil && billing.syncLeaseUntil > now) throw new BillingError("FINANCIAL_SYNC_BUSY", 503);
    if (billing.paidThrough && billing.paidThrough > now) throw new BillingError("ALREADY_PAID");
    if (billing.currentSubscription?.renewalStatus === "ACTIVE") throw new BillingError("SUBSCRIPTION_EXISTS");
    const active = await tx.billingCheckout.findFirst({ where: { workspaceId, ...scope, status: { in: ["CREATING", "OPEN", "UNKNOWN"] } } });
    if (active) {
      if (active.planId !== input.planId || active.amountCents !== plan.amountCents) throw new BillingError("CHECKOUT_IN_PROGRESS");
      return { row: active, created: false };
    }
    const recent = await tx.billingCheckout.count({ where: { workspaceId, ...scope, createdAt: { gte: new Date(now.getTime() - 15 * 60_000) } } });
    if (recent >= 5) throw new BillingError("RATE_LIMITED", 429);
    const date = saoPauloDate(now);
    const row = await tx.billingCheckout.create({ data: { workspaceId, ...scope, requestId: input.requestId, planId: input.planId, amountCents: plan.amountCents, firstChargeDate: date, billingAnchorDay: Number(date.slice(-2)) } });
    return { row, created: true };
  });
  if (!reservation.created) {
    if (reservation.row.status === "OPEN" && reservation.row.providerCheckoutId && Date.now() - reservation.row.createdAt.getTime() > 65 * 60_000) {
      const refreshNow = new Date();
      const claim = await prisma.billingCheckout.updateMany({ where: { id: reservation.row.id, workspaceId, ...scope, status: "OPEN", providerCheckoutId: reservation.row.providerCheckoutId,
        updatedAt: reservation.row.updatedAt, OR: [{ lastOwnerRefreshAt: null }, { lastOwnerRefreshAt: { lte: new Date(refreshNow.getTime() - 5 * 60_000) } }] },
      data: { lastOwnerRefreshAt: refreshNow, updatedAt: reservation.row.updatedAt } });
      if (claim.count !== 1) throw new BillingError("CHECKOUT_REFRESH_THROTTLED", 429);
      await reconcileBillingResource({ checkoutId: reservation.row.providerCheckoutId, recoverExpiredOpen: true }, gateway);
      return readCheckout(workspaceId, reservation.row.id);
    }
    return checkoutDTO(reservation.row);
  }

  const row = reservation.row;
  let result: Awaited<ReturnType<typeof gateway.createHostedCheckout>> | undefined;
  try {
    result = await gateway.createHostedCheckout({ reference: row.id, name: `PING CHAT — ${plan.name}`, amountCents: row.amountCents, firstChargeDate: row.firstChargeDate });
    const encryptedUrl = encryptToken(result.url);
    const saved = await prisma.billingCheckout.updateMany({ where: { id: row.id, workspaceId, status: { in: ["CREATING", "UNKNOWN"] }, OR: [{ providerCheckoutId: null }, { providerCheckoutId: result.id }] }, data: { providerCheckoutId: result.id, checkoutUrlCiphertext: encryptedUrl, status: "OPEN", lastErrorCode: null } });
    if (saved.count !== 1) throw new BillingError("CHECKOUT_CONFLICT");
    return checkoutDTO(await prisma.billingCheckout.findFirstOrThrow({ where: { id: row.id, workspaceId } }));
  } catch (error) {
    const rejected = error instanceof AsaasError && error.code === "REJECTED";
    await prisma.billingCheckout.updateMany({ where: { id: row.id, workspaceId, status: { in: ["CREATING", "UNKNOWN"] } }, data: { status: rejected ? "REJECTED" : "UNKNOWN", lastErrorCode: rejected ? "PROVIDER_REJECTED" : "CREATE_UNKNOWN", ...(result ? { providerCheckoutId: result.id } : {}) } }).catch(() => {});
    // If persistence also failed, CREATING remains durable and is never re-POSTed.
    throw new BillingError(rejected ? "PROVIDER_REJECTED" : "CHECKOUT_OUTCOME_UNKNOWN", rejected ? 422 : 503);
  }
}

export async function readCheckout(workspaceId: string, id: string) {
  if (!isBillingEnabled()) throw new BillingError("BILLING_DISABLED", 404);
  if (!z.uuid().safeParse(id).success) throw new BillingError("INVALID_REQUEST", 400);
  const row = await prisma.billingCheckout.findFirst({ where: { id, workspaceId, ...getBillingProviderScope() } });
  if (!row) throw new BillingError("NOT_FOUND", 404);
  return checkoutDTO(row);
}

/** Recovery can classify an interrupted POST, but must never repeat it. */
export async function recoverInterruptedCheckouts() {
  return prisma.billingCheckout.updateMany({ where: { ...getBillingProviderScope(), status: "CREATING", createdAt: { lt: new Date(Date.now() - 120_000) } }, data: { status: "UNKNOWN", lastErrorCode: "CREATE_INTERRUPTED" } });
}
