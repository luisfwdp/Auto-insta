CREATE TYPE "BillingStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'SUSPENDED');

CREATE TABLE "TrialRedemption" (
  "ownerId" TEXT NOT NULL,
  "trialStartedAt" TIMESTAMP(3) NOT NULL,
  "trialEndsAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrialRedemption_pkey" PRIMARY KEY ("ownerId"),
  CONSTRAINT "TrialRedemption_trial_valid" CHECK ("trialEndsAt" = "trialStartedAt" + INTERVAL '3 days'),
  CONSTRAINT "TrialRedemption_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkspaceBilling" (
  "workspaceId" TEXT NOT NULL,
  "status" "BillingStatus" NOT NULL DEFAULT 'TRIALING',
  "trialStartedAt" TIMESTAMP(3) NOT NULL,
  "trialEndsAt" TIMESTAMP(3) NOT NULL,
  "paidThrough" TIMESTAMP(3),
  "planId" TEXT,
  "providerCustomerId" TEXT,
  "providerSubscriptionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceBilling_pkey" PRIMARY KEY ("workspaceId"),
  CONSTRAINT "WorkspaceBilling_trial_valid" CHECK ("trialEndsAt" = "trialStartedAt" + INTERVAL '3 days'),
  CONSTRAINT "WorkspaceBilling_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkspaceBilling_providerSubscriptionId_key" ON "WorkspaceBilling"("providerSubscriptionId");

-- Later payment reconciliation may update status, never either original deadline.
CREATE FUNCTION "preserve_billing_trial_deadline"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."trialStartedAt" IS DISTINCT FROM OLD."trialStartedAt"
     OR NEW."trialEndsAt" IS DISTINCT FROM OLD."trialEndsAt" THEN
    RAISE EXCEPTION 'The original trial deadline is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "WorkspaceBilling_preserve_trial" BEFORE UPDATE OF "trialStartedAt", "trialEndsAt"
  ON "WorkspaceBilling" FOR EACH ROW EXECUTE FUNCTION "preserve_billing_trial_deadline"();
CREATE TRIGGER "TrialRedemption_preserve_trial" BEFORE UPDATE OF "trialStartedAt", "trialEndsAt"
  ON "TrialRedemption" FOR EACH ROW EXECUTE FUNCTION "preserve_billing_trial_deadline"();

-- Billing is server-only: no direct anonymous/browser Data API access.
ALTER TABLE "WorkspaceBilling" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrialRedemption" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "WorkspaceBilling" FROM PUBLIC;
REVOKE ALL ON TABLE "TrialRedemption" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "WorkspaceBilling" FROM anon';
    EXECUTE 'REVOKE ALL ON TABLE "TrialRedemption" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE "WorkspaceBilling" FROM authenticated';
    EXECUTE 'REVOKE ALL ON TABLE "TrialRedemption" FROM authenticated';
  END IF;
END $$;
