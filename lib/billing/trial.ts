import { prisma } from "@/lib/db/client";
import type { WorkspaceBilling } from "@/app/generated/prisma/client";

export const CARD_FREE_TRIAL_DAYS = 3;
const TRIAL_MS = CARD_FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000;

export function isBillingEnabled() {
  return process.env.BILLING_ENABLED?.trim().toLowerCase() === "true";
}

/** This allowlisted DTO never exposes provider/customer IDs or payment data. */
export function billingStatusDTO(record: WorkspaceBilling | null, now = new Date()) {
  if (!record) return { status: "NOT_STARTED" as const, trialStartedAt: null, trialEndsAt: null, paidThrough: null, planId: null, hasAccess: false };
  // Canceling renewal must not discard a period already paid. Suspension does.
  const activePayment = ["ACTIVE", "CANCELED", "PAST_DUE"].includes(record.status) && record.paidThrough !== null && record.paidThrough > now;
  const activeTrial = record.status === "TRIALING" && record.trialStartedAt <= now && record.trialEndsAt > now;
  const status = (record.status === "TRIALING" && !activeTrial) || (record.status === "ACTIVE" && !activePayment) ? "EXPIRED" : record.status;
  return {
    status,
    trialStartedAt: record.trialStartedAt.toISOString(),
    trialEndsAt: record.trialEndsAt.toISOString(),
    paidThrough: record.paidThrough?.toISOString() ?? null,
    planId: record.planId,
    hasAccess: activePayment || activeTrial,
  };
}

/** Atomic owner redemption prevents workspace replacement from resetting trial. */
export async function startCardFreeTrial(workspaceId: string) {
  const now = new Date();
  const record = await prisma.$transaction(async tx => {
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { ownerId: true, billing: true } });
    const trial = await tx.trialRedemption.upsert({
      where: { ownerId: workspace.ownerId },
      create: { ownerId: workspace.ownerId, trialStartedAt: workspace.billing?.trialStartedAt ?? now, trialEndsAt: workspace.billing?.trialEndsAt ?? new Date(now.getTime() + TRIAL_MS) },
      update: { ownerId: workspace.ownerId },
    });
    await tx.workspaceBilling.createMany({ data: [{ workspaceId, trialStartedAt: trial.trialStartedAt, trialEndsAt: trial.trialEndsAt }], skipDuplicates: true });
    return tx.workspaceBilling.findUniqueOrThrow({ where: { workspaceId } });
  });
  return billingStatusDTO(record);
}

export async function getWorkspaceBillingStatus(workspaceId: string) {
  return billingStatusDTO(await prisma.workspaceBilling.findUnique({ where: { workspaceId } }));
}
