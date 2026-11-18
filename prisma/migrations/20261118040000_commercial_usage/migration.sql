-- CreateEnum
CREATE TYPE "CommercialUsageSubject" AS ENUM ('OWNER_TRIAL', 'WORKSPACE_PAID');

-- CreateEnum
CREATE TYPE "CommercialUsageResource" AS ENUM ('DM', 'PUBLICATION', 'STORAGE_BYTES', 'TRANSFER_BYTES');

-- CreateEnum
CREATE TYPE "CommercialUsageState" AS ENUM ('RESERVED', 'DISPATCHING', 'COMMITTED', 'RELEASED');

-- CreateTable
CREATE TABLE "CommercialUsageBucket" (
    "id" UUID NOT NULL,
    "subjectKind" "CommercialUsageSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "resource" "CommercialUsageResource" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "limitSnapshot" BIGINT NOT NULL,
    "reserved" BIGINT NOT NULL DEFAULT 0,
    "consumed" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommercialUsageBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialUsageReservation" (
    "id" UUID NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bucketId" UUID NOT NULL,
    "resource" "CommercialUsageResource" NOT NULL,
    "operationKey" VARCHAR(200) NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "CommercialUsageState" NOT NULL DEFAULT 'RESERVED',
    "dispatchToken" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommercialUsageReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommercialUsageBucket_subjectKind_subjectId_scopeKey_resour_key" ON "CommercialUsageBucket"("subjectKind", "subjectId", "scopeKey", "resource", "periodStart");

-- CreateIndex
CREATE INDEX "CommercialUsageReservation_bucketId_idx" ON "CommercialUsageReservation"("bucketId");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialUsageReservation_workspaceId_resource_operationKe_key" ON "CommercialUsageReservation"("workspaceId", "resource", "operationKey");

CREATE UNIQUE INDEX "CommercialUsageBucket_id_resource_key" ON "CommercialUsageBucket"("id", "resource");

-- AddForeignKey
ALTER TABLE "CommercialUsageReservation" ADD CONSTRAINT "CommercialUsageReservation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialUsageReservation" ADD CONSTRAINT "CommercialUsageReservation_bucketId_resource_fkey" FOREIGN KEY ("bucketId", "resource") REFERENCES "CommercialUsageBucket"("id", "resource") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Limits may decrease below retained usage on a downgrade. Never delete stored
-- data or reset counters to make a lower plan appear to fit. The server checks
-- current entitlement under the bucket lock for each new allocation.
ALTER TABLE "CommercialUsageBucket"
  ADD CONSTRAINT "CommercialUsageBucket_nonnegative" CHECK ("reserved" >= 0 AND "consumed" >= 0),
  ADD CONSTRAINT "CommercialUsageBucket_limit_positive" CHECK ("limitSnapshot" > 0),
  ADD CONSTRAINT "CommercialUsageBucket_period_valid" CHECK ("periodEnd" > "periodStart");
ALTER TABLE "CommercialUsageReservation"
  ADD CONSTRAINT "CommercialUsageReservation_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "CommercialUsageReservation_dispatch_binding" CHECK (
    ("status" IN ('DISPATCHING', 'COMMITTED') AND "dispatchToken" IS NOT NULL)
    OR ("status" IN ('RESERVED', 'RELEASED') AND "dispatchToken" IS NULL));

CREATE TRIGGER "CommercialUsageBucket_snapshot_immutable" BEFORE UPDATE ON "CommercialUsageBucket"
FOR EACH ROW EXECUTE FUNCTION "billing_financial_snapshot_immutable"('reserved,consumed,updatedAt');
CREATE TRIGGER "CommercialUsageReservation_snapshot_immutable" BEFORE UPDATE ON "CommercialUsageReservation"
FOR EACH ROW EXECUTE FUNCTION "billing_financial_snapshot_immutable"('status,dispatchToken,updatedAt');

DO $$
DECLARE usage_table text;
BEGIN
  FOREACH usage_table IN ARRAY ARRAY['CommercialUsageBucket', 'CommercialUsageReservation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', usage_table);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', usage_table);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', usage_table);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', usage_table);
    END IF;
  END LOOP;
END;
$$;

-- Enforce the server-derived quota subject on insert, including global owner
-- trials, even if an internal caller accidentally binds an unrelated bucket.
CREATE FUNCTION "commercial_usage_binding_valid"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "CommercialUsageBucket" b
    JOIN "Workspace" w ON w."id" = NEW."workspaceId"
    WHERE b."id" = NEW."bucketId" AND b."resource" = NEW."resource"
      AND ((b."subjectKind" = 'WORKSPACE_PAID' AND b."subjectId" = w."id")
        OR (b."subjectKind" = 'OWNER_TRIAL' AND b."subjectId" = w."ownerId"))
  ) THEN
    RAISE EXCEPTION 'Usage reservation binding mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CommercialUsageReservation_binding_valid" BEFORE INSERT ON "CommercialUsageReservation"
FOR EACH ROW EXECUTE FUNCTION "commercial_usage_binding_valid"();
