-- TEMPLATE ONLY. Replace all identifiers after specific human review/authorization.
-- Adds one audited lifetime license; no payments, trial, env or Asaas changes.
BEGIN;
SET LOCAL TIME ZONE 'UTC';
DO $$
DECLARE current_owner text; billing_record record; license_record record;
BEGIN
  IF position('REPLACE_AFTER_REVIEW' in 'WORKSPACE_ID_REPLACE_AFTER_REVIEW') > 0
     OR position('REPLACE_AFTER_REVIEW' in 'OWNER_ID_REPLACE_AFTER_REVIEW') > 0
     OR 'OPERATOR_ID' = ('OPERATOR_' || 'ID')
     OR 'APPROVED_REASON' = ('APPROVED_' || 'REASON')
     OR 'APPROVAL_REFERENCE' = ('APPROVAL_' || 'REFERENCE')
     OR '00000000-0000-4000-8000-000000000001'::uuid = '00000000000040008000000000000001'::uuid
  THEN RAISE EXCEPTION 'Replace all administrative grant template placeholders'; END IF;
  PERFORM 1 FROM public."User" WHERE id='OWNER_ID_REPLACE_AFTER_REVIEW' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expected owner missing'; END IF;
  SELECT "ownerId" INTO current_owner FROM public."Workspace" WHERE id='WORKSPACE_ID_REPLACE_AFTER_REVIEW' FOR UPDATE;
  IF current_owner IS DISTINCT FROM 'OWNER_ID_REPLACE_AFTER_REVIEW' THEN RAISE EXCEPTION 'Workspace owner changed'; END IF;
  SELECT * INTO billing_record FROM public."WorkspaceBilling" WHERE "workspaceId"='WORKSPACE_ID_REPLACE_AFTER_REVIEW' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expected billing record missing'; END IF;
  IF billing_record.status='SUSPENDED' OR billing_record."currentSubscriptionId" IS NOT NULL
     OR billing_record."paidThrough">CURRENT_TIMESTAMP OR billing_record."syncLeaseUntil">CURRENT_TIMESTAMP
     OR EXISTS(SELECT 1 FROM public."BillingSubscription" WHERE "workspaceId"='WORKSPACE_ID_REPLACE_AFTER_REVIEW' AND "renewalStatus"='ACTIVE')
     OR EXISTS(SELECT 1 FROM public."BillingCheckout" WHERE "workspaceId"='WORKSPACE_ID_REPLACE_AFTER_REVIEW' AND status IN ('CREATING','OPEN','UNKNOWN'))
  THEN RAISE EXCEPTION 'Resolve financial or administrative state before grant'; END IF;
  INSERT INTO public."WorkspaceLifetimeAccess" ("workspaceId",id,"ownerId","planId","grantedBy",reason,"approvalReference")
  VALUES ('WORKSPACE_ID_REPLACE_AFTER_REVIEW','00000000-0000-4000-8000-000000000001','OWNER_ID_REPLACE_AFTER_REVIEW','agency-v1','OPERATOR_ID','APPROVED_REASON','APPROVAL_REFERENCE')
  ON CONFLICT ("workspaceId") DO NOTHING;
  SELECT * INTO license_record FROM public."WorkspaceLifetimeAccess" WHERE "workspaceId"='WORKSPACE_ID_REPLACE_AFTER_REVIEW';
  IF license_record.id IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid OR license_record."ownerId" IS DISTINCT FROM 'OWNER_ID_REPLACE_AFTER_REVIEW'
     OR license_record."planId" IS DISTINCT FROM 'agency-v1' OR license_record."revokedAt" IS NOT NULL
     OR license_record."grantedBy" IS DISTINCT FROM 'OPERATOR_ID'
     OR license_record.reason IS DISTINCT FROM 'APPROVED_REASON'
     OR license_record."approvalReference" IS DISTINCT FROM 'APPROVAL_REFERENCE'
  THEN RAISE EXCEPTION 'Existing license differs; do not overwrite'; END IF;
END $$;
COMMIT;
