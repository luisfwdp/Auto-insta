import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { loadCommercialEntitlement } from "./commercial-access";
import { BillingError } from "./config";
import type { CommercialEntitlement } from "./entitlements";
import { isBillingEnabled } from "./trial";
import { BILLING_PLAN_IDS } from "./catalog";

type Tx = Prisma.TransactionClient;
type ActiveEntitlement = Exclude<CommercialEntitlement, { status: "denied" }>;
const normalizedEmail = (email: string) => email.trim().toLowerCase();

async function lockOwner(tx: Tx, workspaceId: string) {
  const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true, owner: { select: { email: true } } } });
  if (!workspace) throw new BillingError("COMMERCIAL_ACCESS_DENIED", 402);
  // All account/member admissions for this owner share the lock, including
  // admissions into different workspaces using the same owner trial.
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${workspace.ownerId} FOR UPDATE`;
  return workspace;
}

async function activeEntitlement(tx: Tx, workspaceId: string): Promise<ActiveEntitlement> {
  const entitlement = await loadCommercialEntitlement(tx, workspaceId, new Date());
  if (!entitlement || entitlement.status === "denied") throw new BillingError("COMMERCIAL_ACCESS_DENIED", 402);
  return entitlement;
}

function capacityScope(entitlement: ActiveEntitlement, workspaceId: string) {
  if (entitlement.subjectKind !== "OWNER_TRIAL") return { workspaceId };
  // Paid/licensed workspaces do not consume shared free-trial capacity.
  return { workspace: { ownerId: entitlement.subjectId, billing: { is: { status: "TRIALING" as const,
    trialStartedAt: entitlement.periodStart, trialEndsAt: entitlement.periodEnd,
    NOT: { lifetimeAccess: { is: { ownerId: entitlement.subjectId, revokedAt: null, grantedAt: { lte: new Date() }, planId: { in: [...BILLING_PLAN_IDS] } } } },
  } } } };
}

/** Preflight for OAuth entry. Capacity itself is checked after the real ID is
 * known, so reaching the cap must never prevent reconnecting an existing ID. */
export async function assertCommercialCapacityAccess(workspaceId: string) {
  if (!isBillingEnabled()) return;
  await prisma.$transaction(async tx => { await lockOwner(tx, workspaceId); await activeEntitlement(tx, workspaceId); });
}

/** Caller performs its existing lookup/insert in this SAME transaction.
 * Network requests must stay outside. Legacy mode adds no query/transaction. */
export async function withCommercialAccountCapacity<T>(workspaceId: string, instagramId: string, write: (tx: Tx) => Promise<T>, transaction?: Tx): Promise<T> {
  if (!isBillingEnabled()) return write(transaction ?? prisma);
  const run = async (tx: Tx) => {
    await lockOwner(tx, workspaceId);
    const entitlement = await activeEntitlement(tx, workspaceId);
    const existing = await tx.instagramAccount.findUnique({ where: { instagramId }, select: { workspaceId: true } });
    if (existing && existing.workspaceId !== workspaceId) throw new BillingError("COMMERCIAL_ACCOUNT_NOT_AVAILABLE", 409);
    if (!existing && await tx.instagramAccount.count({ where: capacityScope(entitlement, workspaceId) }) >= entitlement.limits.accounts) throw new BillingError("COMMERCIAL_ACCOUNT_LIMIT", 409);
    return write(tx);
  };
  return transaction ? run(transaction) : prisma.$transaction(run);
}

/** Dispatch guard used by DM/publication workers. Surplus connections are
 * retained; only the oldest currently connectedAt/id-ordered N are usable.
 * Recreating a disconnected connection can change that ordering. */
export async function assertCommercialAccountUsable(workspaceId: string, instagramId: string): Promise<void> {
  if (!isBillingEnabled()) return;
  if (!workspaceId || !instagramId || typeof workspaceId !== "string" || typeof instagramId !== "string") throw new BillingError("COMMERCIAL_ACCOUNT_NOT_AVAILABLE", 404);
  await prisma.$transaction(async tx => {
    await lockOwner(tx, workspaceId);
    const entitlement = await activeEntitlement(tx, workspaceId);
    const account = await tx.instagramAccount.findFirst({ where: { workspaceId, instagramId }, select: { id: true } });
    if (!account) throw new BillingError("COMMERCIAL_ACCOUNT_NOT_AVAILABLE", 404);
    const allowed = await tx.instagramAccount.findMany({ where: capacityScope(entitlement, workspaceId), orderBy: [{ connectedAt: "asc" }, { id: "asc" }], take: entitlement.limits.accounts, select: { id: true } });
    if (!allowed.some(value => value.id === account.id)) throw new BillingError("COMMERCIAL_ACCOUNT_LIMIT", 409);
  });
}

/** Resolve legitimate pre-existing users without creating a duplicate pending
 * seat merely because an older email used mixed case. Ambiguity fails closed. */
export async function findCommercialInvitationUser(tx: Tx, email: string) {
  const users = await tx.user.findMany({ where: { email: { equals: normalizedEmail(email), mode: "insensitive" } }, select: { id: true }, take: 2 });
  if (users.length > 1) throw new BillingError("COMMERCIAL_INVITATION_AMBIGUOUS", 409);
  return users[0] ?? null;
}

/** Caller must invoke before consuming an invitation or inserting membership,
 * while retaining this transaction through the write. Pending valid invitations
 * reserve one seat per normalized email, excluding identities already members. */
export async function assertCommercialMemberCapacity(tx: Tx, workspaceId: string, candidate: { userId?: string; email: string }) {
  if (!isBillingEnabled()) return;
  const workspace = await lockOwner(tx, workspaceId);
  if (candidate.userId && await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: candidate.userId } }, select: { id: true } })) return;
  const entitlement = await activeEntitlement(tx, workspaceId);
  if (candidate.userId === workspace.ownerId) return;
  const scope = capacityScope(entitlement, workspaceId), now = new Date();
  const [members, invitations] = await Promise.all([
    tx.workspaceMember.findMany({ where: scope, select: { userId: true, user: { select: { email: true } } } }),
    tx.workspaceInvitation.findMany({ where: { ...scope, status: "PENDING", expiresAt: { gt: now } }, select: { email: true } }),
  ]);
  const identities = new Set([workspace.ownerId, ...members.map(member => member.userId)]);
  const memberEmails = new Set(members.flatMap(member => member.user.email ? [normalizedEmail(member.user.email)] : []));
  if (workspace.owner.email) memberEmails.add(normalizedEmail(workspace.owner.email));
  const reserved = new Set(invitations.map(invitation => normalizedEmail(invitation.email)).filter(email => !memberEmails.has(email)));
  const seats = identities.size + reserved.size, email = normalizedEmail(candidate.email);
  if (seats > entitlement.limits.members || (seats === entitlement.limits.members && !reserved.has(email))) throw new BillingError("COMMERCIAL_MEMBER_LIMIT", 409);
}
