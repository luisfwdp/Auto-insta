import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { BillingError } from "./config";

/** Network reads happen outside transactions, serialized by a recoverable lease. */
export async function claimBillingSync(workspaceId: string) {
  const now = new Date(), token = randomUUID();
  const claimed = await prisma.workspaceBilling.updateMany({
    where: { workspaceId, OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lte: now } }] },
    data: { syncLeaseToken: token, syncLeaseUntil: new Date(now.getTime() + 180_000) },
  });
  if (claimed.count !== 1) throw new BillingError("FINANCIAL_SYNC_BUSY", 503);
  return token;
}

export async function assertBillingSyncLease(tx: Prisma.TransactionClient, workspaceId: string, token: string) {
  await tx.$queryRaw`SELECT "workspaceId" FROM "WorkspaceBilling" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
  const row = await tx.workspaceBilling.findUniqueOrThrow({ where: { workspaceId } });
  if (row.syncLeaseToken !== token || !row.syncLeaseUntil || row.syncLeaseUntil <= new Date()) throw new BillingError("SYNC_LEASE_LOST", 503);
  return row;
}

export async function releaseBillingSync(workspaceId: string, token: string) {
  await prisma.workspaceBilling.updateMany({ where: { workspaceId, syncLeaseToken: token }, data: { syncLeaseToken: null, syncLeaseUntil: null } });
}
