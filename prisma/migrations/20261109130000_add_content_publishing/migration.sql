-- Additive content publishing contract. Production execution requires human approval.
CREATE TYPE "PublishingMediaType" AS ENUM ('IMAGE', 'VIDEO');
CREATE TYPE "PublishingAssetStatus" AS ENUM ('UPLOADING', 'READY', 'FAILED', 'DELETED');
CREATE TYPE "PublicationType" AS ENUM ('IMAGE_POST', 'CAROUSEL', 'REEL');
CREATE TYPE "PublicationStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'QUEUED', 'PROCESSING', 'PUBLISHED', 'FAILED', 'CANCELLED');
CREATE TYPE "PublishingReelMode" AS ENUM ('STANDARD', 'TRIAL');
CREATE TYPE "SpeedPostBatchStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');
CREATE TYPE "SpeedPostOrder" AS ENUM ('MANUAL', 'SEQUENTIAL', 'RANDOM');
CREATE TYPE "SpeedPostSchedule" AS ENUM ('FIXED', 'CUSTOM');

CREATE TABLE "PublishingAsset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "mediaType" "PublishingMediaType" NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "checksum" TEXT,
    "status" "PublishingAssetStatus" NOT NULL DEFAULT 'UPLOADING',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PublishingAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SpeedPostBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SpeedPostBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "postsPerDay" INTEGER NOT NULL,
    "scheduleMode" "SpeedPostSchedule" NOT NULL,
    "orderMode" "SpeedPostOrder" NOT NULL,
    "timezone" TEXT NOT NULL,
    "timeSlots" JSONB NOT NULL,
    "defaultCaption" TEXT,
    "reelMode" "PublishingReelMode" NOT NULL DEFAULT 'STANDARD',
    "startsOn" DATE NOT NULL,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "publishedItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "randomSeed" TEXT,
    "pausedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SpeedPostBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduledPublication" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "batchId" TEXT,
    "type" "PublicationType" NOT NULL,
    "reelMode" "PublishingReelMode" NOT NULL DEFAULT 'STANDARD',
    "caption" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "timezone" TEXT NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "idempotencyKey" TEXT NOT NULL,
    "metaContainerId" TEXT,
    "metaMediaId" TEXT,
    "metaStatus" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScheduledPublication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PublicationAsset" (
    "publicationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "PublicationAsset_pkey" PRIMARY KEY ("publicationId", "assetId")
);

CREATE UNIQUE INDEX "PublishingAsset_storagePath_key" ON "PublishingAsset"("storagePath");
CREATE INDEX "PublishingAsset_workspaceId_createdAt_idx" ON "PublishingAsset"("workspaceId", "createdAt");
CREATE INDEX "PublishingAsset_workspaceId_status_idx" ON "PublishingAsset"("workspaceId", "status");
CREATE UNIQUE INDEX "ScheduledPublication_idempotencyKey_key" ON "ScheduledPublication"("idempotencyKey");
CREATE INDEX "ScheduledPublication_workspaceId_scheduledFor_idx" ON "ScheduledPublication"("workspaceId", "scheduledFor");
CREATE INDEX "ScheduledPublication_workspaceId_status_idx" ON "ScheduledPublication"("workspaceId", "status");
CREATE INDEX "ScheduledPublication_instagramAccountId_status_scheduledFor_idx" ON "ScheduledPublication"("instagramAccountId", "status", "scheduledFor");
CREATE INDEX "ScheduledPublication_batchId_scheduledFor_idx" ON "ScheduledPublication"("batchId", "scheduledFor");
CREATE UNIQUE INDEX "PublicationAsset_publicationId_position_key" ON "PublicationAsset"("publicationId", "position");
CREATE INDEX "PublicationAsset_assetId_idx" ON "PublicationAsset"("assetId");
CREATE INDEX "SpeedPostBatch_workspaceId_createdAt_idx" ON "SpeedPostBatch"("workspaceId", "createdAt");
CREATE INDEX "SpeedPostBatch_workspaceId_status_idx" ON "SpeedPostBatch"("workspaceId", "status");
CREATE INDEX "SpeedPostBatch_instagramAccountId_status_idx" ON "SpeedPostBatch"("instagramAccountId", "status");

ALTER TABLE "PublishingAsset" ADD CONSTRAINT "PublishingAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpeedPostBatch" ADD CONSTRAINT "SpeedPostBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpeedPostBatch" ADD CONSTRAINT "SpeedPostBatch_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledPublication" ADD CONSTRAINT "ScheduledPublication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledPublication" ADD CONSTRAINT "ScheduledPublication_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledPublication" ADD CONSTRAINT "ScheduledPublication_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SpeedPostBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PublicationAsset" ADD CONSTRAINT "PublicationAsset_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "ScheduledPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicationAsset" ADD CONSTRAINT "PublicationAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PublishingAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
