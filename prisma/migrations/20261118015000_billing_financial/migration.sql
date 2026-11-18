-- CreateEnum
CREATE TYPE "BillingEnvironment" AS ENUM ('sandbox', 'production');

-- CreateEnum
CREATE TYPE "BillingCheckoutStatus" AS ENUM ('CREATING', 'OPEN', 'UNKNOWN', 'COMPLETED', 'CANCELED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BillingWorkStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY', 'PROCESSED', 'DEAD');

-- AlterTable
ALTER TABLE "WorkspaceBilling" ADD COLUMN     "currentSubscriptionId" UUID,
ADD COLUMN     "syncLeaseToken" UUID,
ADD COLUMN     "syncLeaseUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BillingCheckout" (
    "id" UUID NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "environment" "BillingEnvironment" NOT NULL,
    "accountScope" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "planId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "firstChargeDate" VARCHAR(10) NOT NULL,
    "billingAnchorDay" INTEGER NOT NULL,
    "status" "BillingCheckoutStatus" NOT NULL DEFAULT 'CREATING',
    "providerCheckoutId" UUID,
    "checkoutUrlCiphertext" TEXT,
    "lastErrorCode" TEXT,
    "recoveryEnqueuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingCheckout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscription" (
    "id" UUID NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "environment" "BillingEnvironment" NOT NULL,
    "accountScope" UUID NOT NULL,
    "providerSubscriptionId" TEXT NOT NULL,
    "providerCustomerId" TEXT NOT NULL,
    "checkoutId" UUID NOT NULL,
    "planId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "billingAnchorDay" INTEGER NOT NULL,
    "renewalStatus" TEXT NOT NULL,
    "recoveryEnqueuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPayment" (
    "id" UUID NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "environment" "BillingEnvironment" NOT NULL,
    "accountScope" UUID NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "dueDate" VARCHAR(10) NOT NULL,
    "status" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" UUID NOT NULL,
    "environment" "BillingEnvironment" NOT NULL,
    "accountScope" UUID NOT NULL,
    "eventId" VARCHAR(200) NOT NULL,
    "eventType" VARCHAR(64) NOT NULL,
    "paymentId" TEXT,
    "subscriptionId" TEXT,
    "checkoutId" UUID,
    "status" "BillingWorkStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCommand" (
    "id" UUID NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "status" "BillingWorkStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingCheckout_workspaceId_createdAt_idx" ON "BillingCheckout"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCheckout_workspaceId_requestId_key" ON "BillingCheckout"("workspaceId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCheckout_id_workspaceId_environment_accountScope_key" ON "BillingCheckout"("id", "workspaceId", "environment", "accountScope");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCheckout_environment_accountScope_providerCheckoutId_key" ON "BillingCheckout"("environment", "accountScope", "providerCheckoutId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_checkoutId_key" ON "BillingSubscription"("checkoutId");

-- CreateIndex
CREATE INDEX "BillingSubscription_workspaceId_idx" ON "BillingSubscription"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_id_workspaceId_key" ON "BillingSubscription"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_id_workspaceId_environment_accountScope_key" ON "BillingSubscription"("id", "workspaceId", "environment", "accountScope");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_checkoutId_workspaceId_environment_acco_key" ON "BillingSubscription"("checkoutId", "workspaceId", "environment", "accountScope");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_environment_accountScope_providerSubscr_key" ON "BillingSubscription"("environment", "accountScope", "providerSubscriptionId");

-- CreateIndex
CREATE INDEX "BillingPayment_workspaceId_subscriptionId_idx" ON "BillingPayment"("workspaceId", "subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_environment_accountScope_providerPaymentId_key" ON "BillingPayment"("environment", "accountScope", "providerPaymentId");

-- CreateIndex
CREATE INDEX "BillingEvent_status_nextAttemptAt_idx" ON "BillingEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_environment_accountScope_eventId_key" ON "BillingEvent"("environment", "accountScope", "eventId");

-- CreateIndex
CREATE INDEX "BillingCommand_status_nextAttemptAt_idx" ON "BillingCommand"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCommand_workspaceId_requestId_key" ON "BillingCommand"("workspaceId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBilling_currentSubscriptionId_key" ON "WorkspaceBilling"("currentSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBilling_currentSubscriptionId_workspaceId_key" ON "WorkspaceBilling"("currentSubscriptionId", "workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceBilling" ADD CONSTRAINT "WorkspaceBilling_currentSubscriptionId_workspaceId_fkey" FOREIGN KEY ("currentSubscriptionId", "workspaceId") REFERENCES "BillingSubscription"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingCheckout" ADD CONSTRAINT "BillingCheckout_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "WorkspaceBilling"("workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "WorkspaceBilling"("workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_checkoutId_workspaceId_environment_acc_fkey" FOREIGN KEY ("checkoutId", "workspaceId", "environment", "accountScope") REFERENCES "BillingCheckout"("id", "workspaceId", "environment", "accountScope") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_subscriptionId_workspaceId_environment_acco_fkey" FOREIGN KEY ("subscriptionId", "workspaceId", "environment", "accountScope") REFERENCES "BillingSubscription"("id", "workspaceId", "environment", "accountScope") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingCommand" ADD CONSTRAINT "BillingCommand_subscriptionId_workspaceId_fkey" FOREIGN KEY ("subscriptionId", "workspaceId") REFERENCES "BillingSubscription"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One unresolved remote checkout per tenant/provider binding. UNKNOWN must be
-- reconciled rather than creating another potentially chargeable checkout.
CREATE UNIQUE INDEX "BillingCheckout_one_unresolved_per_scope_key"
ON "BillingCheckout" ("workspaceId", "environment", "accountScope")
WHERE "status" IN ('CREATING', 'OPEN', 'UNKNOWN');

-- This outbox contains cancellation commands only. Terminal requests retain
-- their audit trail while a later, separately authorized request may be created.
CREATE UNIQUE INDEX "BillingCommand_one_live_cancel_per_subscription_key"
ON "BillingCommand" ("subscriptionId")
WHERE "status" IN ('PENDING', 'PROCESSING', 'RETRY');

ALTER TABLE "BillingCheckout"
  ADD CONSTRAINT "BillingCheckout_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "BillingCheckout_anchor_valid" CHECK ("billingAnchorDay" BETWEEN 1 AND 31);
ALTER TABLE "BillingSubscription"
  ADD CONSTRAINT "BillingSubscription_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "BillingSubscription_anchor_valid" CHECK ("billingAnchorDay" BETWEEN 1 AND 31);
ALTER TABLE "BillingPayment"
  ADD CONSTRAINT "BillingPayment_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "BillingEvent"
  ADD CONSTRAINT "BillingEvent_attempts_nonnegative" CHECK ("attempts" >= 0);
ALTER TABLE "BillingCommand"
  ADD CONSTRAINT "BillingCommand_attempts_nonnegative" CHECK ("attempts" >= 0);

-- Snapshots are insert-once. Only workflow/settlement fields listed per trigger
-- may change. The function never looks up tenant data or accepts arbitrary SQL.
CREATE FUNCTION "billing_financial_snapshot_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - string_to_array(TG_ARGV[0], ','))
      IS DISTINCT FROM (to_jsonb(OLD) - string_to_array(TG_ARGV[0], ',')) THEN
    RAISE EXCEPTION 'Financial snapshot is immutable (%)', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'BillingCheckout' THEN
    IF OLD."providerCheckoutId" IS NOT NULL
        AND NEW."providerCheckoutId" IS DISTINCT FROM OLD."providerCheckoutId" THEN
      RAISE EXCEPTION 'Provider checkout binding is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BillingCheckout_snapshot_immutable" BEFORE UPDATE ON "BillingCheckout"
FOR EACH ROW EXECUTE FUNCTION "billing_financial_snapshot_immutable"('status,providerCheckoutId,checkoutUrlCiphertext,lastErrorCode,recoveryEnqueuedAt,updatedAt');
CREATE TRIGGER "BillingSubscription_snapshot_immutable" BEFORE UPDATE ON "BillingSubscription"
FOR EACH ROW EXECUTE FUNCTION "billing_financial_snapshot_immutable"('renewalStatus,recoveryEnqueuedAt,updatedAt');
CREATE TRIGGER "BillingPayment_snapshot_immutable" BEFORE UPDATE ON "BillingPayment"
FOR EACH ROW EXECUTE FUNCTION "billing_financial_snapshot_immutable"('status,deleted,syncedAt');
CREATE TRIGGER "BillingEvent_snapshot_immutable" BEFORE UPDATE ON "BillingEvent"
FOR EACH ROW EXECUTE FUNCTION "billing_financial_snapshot_immutable"('status,attempts,nextAttemptAt,leaseToken,leaseUntil,lastErrorCode,updatedAt');
CREATE TRIGGER "BillingCommand_snapshot_immutable" BEFORE UPDATE ON "BillingCommand"
FOR EACH ROW EXECUTE FUNCTION "billing_financial_snapshot_immutable"('status,attempts,nextAttemptAt,leaseToken,leaseUntil,lastErrorCode,updatedAt');

-- Server-only records: browser/Data API roles cannot bypass the canonical
-- reconciler, inspect financial resource identifiers or mutate durable commands.
DO $$
DECLARE financial_table text;
BEGIN
  FOREACH financial_table IN ARRAY ARRAY['BillingCheckout', 'BillingSubscription', 'BillingPayment', 'BillingEvent', 'BillingCommand'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', financial_table);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', financial_table);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', financial_table);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', financial_table);
    END IF;
  END LOOP;
END;
$$;
