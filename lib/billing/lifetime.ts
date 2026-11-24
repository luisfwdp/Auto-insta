import { z } from "zod";
import { BILLING_PLANS, type BillingPlanId } from "./catalog";
import { getBillingProviderScope, saoPauloDate } from "./config";
import { monthlyInvoicePeriod } from "./financial-policy";
import type { CommercialEntitlement, CommercialLimits } from "./entitlements";

export interface LifetimeAccessSnapshot {
  id: string; workspaceId: string; ownerId: string; planId: string;
  grantedAt: Date; grantedBy: string; reason: string; approvalReference: string;
  revokedAt: Date | null;
}
export interface LifetimeEntitlement {
  status: "lifetime"; code: "WORKSPACE_LIFETIME_ACTIVE";
  subjectKind: "WORKSPACE_GRANT"; subjectId: string;
  periodStart: Date; periodEnd: Date; limits: CommercialLimits; planId: BillingPlanId;
}
const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
const auditText = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** No expiry date, fake payment or renewed trial. The monthly period is only
 * the quota window; a revoked/suspended/foreign-owner grant authorizes nothing. */
export function evaluateLifetimeAccess(workspace: { id: string; ownerId: string },
  billing: { workspaceId: string; status: string; lifetimeAccess?: LifetimeAccessSnapshot | null } | null,
  now: Date): LifetimeEntitlement | null {
  const grant = billing?.lifetimeAccess;
  if (!grant || !validDate(now) || billing?.status === "SUSPENDED" || billing?.workspaceId !== workspace.id
    || grant.workspaceId !== workspace.id || grant.ownerId !== workspace.ownerId || !z.uuid().safeParse(grant.id).success
    || !validDate(grant.grantedAt) || grant.grantedAt > now || grant.revokedAt !== null
    || !auditText(grant.grantedBy, 200) || !auditText(grant.reason, 500) || !auditText(grant.approvalReference, 500)
    || !Object.hasOwn(BILLING_PLANS, grant.planId)) return null;
  const planId = grant.planId as BillingPlanId;
  const { accounts, members, dms, publications, storageBytes, transferBytes } = BILLING_PLANS[planId];
  const limits = { accounts, members, dms, publications, storageBytes, transferBytes };
  const period = monthlyInvoicePeriod(`${saoPauloDate(now).slice(0, 7)}-01`, 1);
  return { status: "lifetime", code: "WORKSPACE_LIFETIME_ACTIVE", subjectKind: "WORKSPACE_GRANT", subjectId: grant.id,
    periodStart: period.startsAt, periodEnd: period.endsAt, limits, planId };
}

/** Gift usage is independent of Asaas and isolated from paid/trial buckets. */
export function commercialScopeKey(access: Exclude<CommercialEntitlement, { status: "denied" }>) {
  if (access.subjectKind === "OWNER_TRIAL") return "owner-trial-v1";
  if (access.subjectKind === "WORKSPACE_GRANT") return "workspace-lifetime-v1";
  const scope = getBillingProviderScope();
  return `${scope.environment}:${scope.accountScope}`;
}
