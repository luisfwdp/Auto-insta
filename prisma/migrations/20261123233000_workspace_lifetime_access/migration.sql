ALTER TYPE "CommercialUsageSubject" ADD VALUE 'WORKSPACE_GRANT';

CREATE TABLE "WorkspaceLifetimeAccess" (
  "workspaceId" TEXT NOT NULL PRIMARY KEY,
  "id" UUID NOT NULL,
  "ownerId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "grantedBy" VARCHAR(200) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "approvalReference" VARCHAR(500) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokedBy" VARCHAR(200),
  "revocationReason" VARCHAR(500),
  CONSTRAINT "WorkspaceLifetimeAccess_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "WorkspaceBilling"("workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "lifetime_plan_version" CHECK ("planId" IN ('essential-v1', 'pro-v1', 'agency-v1')),
  CONSTRAINT "lifetime_grant_audit" CHECK (length(btrim("ownerId")) > 0 AND length(btrim("grantedBy")) > 0 AND length(btrim("reason")) > 0 AND length(btrim("approvalReference")) > 0),
  CONSTRAINT "lifetime_revoke_audit" CHECK (
    ("revokedAt" IS NULL AND "revokedBy" IS NULL AND "revocationReason" IS NULL) OR
    ("revokedAt" IS NOT NULL AND "revokedBy" IS NOT NULL AND "revocationReason" IS NOT NULL
      AND "revokedAt" >= "grantedAt" AND length(btrim("revokedBy")) > 0 AND length(btrim("revocationReason")) > 0)
  )
);
CREATE UNIQUE INDEX "WorkspaceLifetimeAccess_id_key" ON "WorkspaceLifetimeAccess"("id");
ALTER TABLE "WorkspaceLifetimeAccess" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "WorkspaceLifetimeAccess" FROM PUBLIC;

-- No new role or elevated membership. Browsers and the application runtime
-- cannot issue/revoke a license; only reviewed administrative SQL can do so.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'pingchat_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE %I."WorkspaceLifetimeAccess" FROM %I', current_schema(), role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pingchat_runtime') THEN
    EXECUTE format('GRANT SELECT ON TABLE %I."WorkspaceLifetimeAccess" TO pingchat_runtime', current_schema());
    EXECUTE format('CREATE POLICY backend_lifetime_read ON %I."WorkspaceLifetimeAccess" FOR SELECT TO pingchat_runtime USING (true)', current_schema());
  END IF;
END $$;

-- Extend (never bypass) the existing quota binding guard. A grant bucket is
-- valid only for its exact workspace and current owner; another workspace of
-- the same owner must not borrow the license. Keep SECURITY INVOKER.
CREATE OR REPLACE FUNCTION "commercial_usage_binding_valid"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "CommercialUsageBucket" b
    JOIN "Workspace" w ON w."id" = NEW."workspaceId"
    WHERE b."id" = NEW."bucketId" AND b."resource" = NEW."resource"
      AND ((b."subjectKind" = 'WORKSPACE_PAID' AND b."subjectId" = w."id")
        OR (b."subjectKind" = 'OWNER_TRIAL' AND b."subjectId" = w."ownerId")
        OR (b."subjectKind"::text = 'WORKSPACE_GRANT' AND b."scopeKey" = 'workspace-lifetime-v1'
          AND EXISTS (SELECT 1 FROM "WorkspaceLifetimeAccess" g
            WHERE g."id"::text = b."subjectId" AND g."workspaceId" = w."id"
              AND g."ownerId" = w."ownerId" AND g."revokedAt" IS NULL AND g."grantedAt" <= CURRENT_TIMESTAMP)))
  ) THEN
    RAISE EXCEPTION 'Usage reservation binding mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
