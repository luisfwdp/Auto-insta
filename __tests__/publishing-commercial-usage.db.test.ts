/** Native worker/ledger composition on disposable PostgreSQL. Meta responses
 * are fixtures and establish no claim of real publication or delivery. */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { NextRequest } from "next/server";
import { PrismaClient } from "../app/generated/prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type TestJob = { data: { workspaceId: string; publicationId: string } };
const url = process.env.TEST_DATABASE_URL, schema = `publishing_commercial_${randomBytes(5).toString("hex")}`;
const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  processor: undefined as unknown as (job: TestJob) => Promise<void>,
  wait: vi.fn(), publish: vi.fn(), sign: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/instagram/context", () => ({ createInstagramContext: async () => ({ provider: "META", instagramId: "instagram", accessToken: "fake-native-test-token" }) }));
vi.mock("@/lib/billing/commercial-capacity", () => ({ assertCommercialAccountUsable: async () => {} }));
vi.mock("@/lib/instagram/publish-content", () => ({
  assertContentPublishPermission: async () => {},
  getContentPublishingLimit: async () => ({ quotaUsage: 0, quotaTotal: 100 }),
  createPublishContainer: async () => "new_container",
  waitForContainer: state.wait, publishContainer: state.publish,
}));
vi.mock("@/lib/publishing/storage", () => ({ createSignedDownload: state.sign }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: async () => ({ workspaceId: "workspace", userId: "owner", role: "OWNER" }),
  canManageWorkspace: () => true,
}));
vi.mock("bullmq", () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
  Worker: class {
    constructor(_name: string, processor: typeof state.processor) { state.processor = processor; }
    on() { return this; }
  },
}));
import { createPublishingWorker } from "../lib/queue/publishing-worker";
import { reserveCommercialUsage, beginCommercialDispatch, finishCommercialDispatch } from "../lib/billing/commercial-usage";
import { RateLimitError } from "../lib/meta/client";
import { PATCH as cancelPublication } from "../app/api/publishing/publications/route";
import { PATCH as cancelBatch } from "../app/api/publishing/batches/[id]/route";
import { createPrismaMcpPublishingService } from "../lib/mcp/publishing-tools";

let sql: Client, trialEndsAt: Date;
const job = (id: string) => ({ data: { workspaceId: "workspace", publicationId: id } });
async function publication(id: string, batchId?: string) {
  return state.db.scheduledPublication.create({ data: {
    id, workspaceId: "workspace", instagramAccountId: "account", batchId, type: "REEL", timezone: "UTC",
    status: "QUEUED", idempotencyKey: id, metaContainerId: `container_${id}`,
  } });
}
async function allowance(key: string, amount = 1) {
  const reservation = await reserveCommercialUsage("workspace", "PUBLICATION", key, amount);
  if (!reservation.reservationId) throw new Error("Expected commercial fixture");
  return reservation.reservationId;
}

describe.skipIf(!url)("commercial publication dispatch on isolated PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const migrations = path.join(__dirname, "..", "prisma", "migrations");
    for (const directory of readdirSync(migrations, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort())
      await sql.query(readFileSync(path.join(migrations, directory, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5, options: `-c search_path=${schema}` }, { schema }) });
    await state.db.user.create({ data: { id: "owner" } });
    await state.db.workspace.create({ data: { id: "workspace", name: "Test", ownerId: "owner" } });
    await state.db.instagramAccount.create({ data: { id: "account", workspaceId: "workspace", instagramId: "instagram", username: "test", accessToken: "fixture-only" } });
    createPublishingWorker();
  });
  beforeEach(async () => {
    vi.resetAllMocks(); vi.stubEnv("BILLING_ENABLED", "true");
    await sql.query(`TRUNCATE TABLE "CommercialUsageReservation", "CommercialUsageBucket", "ScheduledPublication", "SpeedPostBatch", "WorkspaceBilling", "TrialRedemption" CASCADE`);
    const trialStartedAt = new Date(Date.now() - 60000); trialEndsAt = new Date(trialStartedAt.getTime() + 72 * 3600000);
    await state.db.trialRedemption.create({ data: { ownerId: "owner", trialStartedAt, trialEndsAt } });
    await state.db.workspaceBilling.create({ data: { workspaceId: "workspace", trialStartedAt, trialEndsAt } });
    state.wait.mockResolvedValue({ status_code: "FINISHED" });
    state.publish.mockResolvedValue("fixture_media");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll(async () => {
    vi.unstubAllEnvs(); await state.db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });

  it("admits exactly one publication when concurrent jobs compete for the last allowance", async () => {
    const previous = await allowance("previous_usage", 9), claim = await beginCommercialDispatch("workspace", previous);
    await finishCommercialDispatch("workspace", previous, claim!.dispatchToken, "CONFIRMED");
    await publication("one"); await publication("two");
    const results = await Promise.allSettled([state.processor(job("one")), state.processor(job("two"))]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toMatchObject([{ reason: { message: "COMMERCIAL_QUOTA_EXCEEDED" } }]);
    expect(state.publish).toHaveBeenCalledOnce();
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(10), reserved: BigInt(0) });
    expect(await state.db.scheduledPublication.count({ where: { status: "PUBLISHED" } })).toBe(1);
    expect(await state.db.scheduledPublication.count({ where: { status: "FAILED", lastError: "COMMERCIAL_QUOTA_EXCEEDED" } })).toBe(1);
  });

  it("persists real publication truth when a stalled duplicate marks the same operation for review", async () => {
    await publication("same_stalled_operation");
    let accepted!: (mediaId: string) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    state.publish.mockImplementationOnce(() => { entered(); return new Promise<string>(resolve => { accepted = resolve; }); });
    const first = state.processor(job("same_stalled_operation"));
    await started;
    try {
      await expect(state.processor(job("same_stalled_operation"))).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
      expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "same_stalled_operation" } })).toMatchObject({ status: "FAILED", lastError: "PUBLICATION_OUTCOME_REVIEW_REQUIRED" });
    } finally { accepted("authoritative_fixture_media"); await first; }
    expect(state.publish).toHaveBeenCalledOnce();
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "same_stalled_operation" } })).toMatchObject({
      status: "PUBLISHED", metaContainerId: "container_same_stalled_operation", metaMediaId: "authoritative_fixture_media", lastError: null,
    });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(1), reserved: BigInt(0) });
    expect(await state.db.commercialUsageReservation.count()).toBe(1);
  });

  it("fills a real late media ID when canonical PUBLISHED recovery finished before the original response", async () => {
    await publication("late_media_id");
    state.wait.mockResolvedValueOnce({ status_code: "FINISHED" }).mockResolvedValueOnce({ status_code: "PUBLISHED" });
    let accepted!: (mediaId: string) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    state.publish.mockImplementationOnce(() => { entered(); return new Promise<string>(resolve => { accepted = resolve; }); });
    const first = state.processor(job("late_media_id")); await started;
    let recovered: { publishedAt: Date | null; cancelledAt: Date | null } | undefined;
    try {
      await state.processor(job("late_media_id"));
      recovered = await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "late_media_id" } });
      expect(recovered).toMatchObject({ status: "PUBLISHED", metaStatus: "PUBLISHED_RECOVERED", metaMediaId: null });
    } finally { accepted("real_original_response_media"); await first; }
    const final = await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "late_media_id" } });
    expect(final).toMatchObject({ status: "PUBLISHED", metaStatus: "PUBLISHED", metaMediaId: "real_original_response_media" });
    expect(final.publishedAt).toEqual(recovered!.publishedAt); expect(final.cancelledAt).toEqual(recovered!.cancelledAt);
    expect(state.publish).toHaveBeenCalledOnce();
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(1), reserved: BigInt(0) });
    expect(await state.db.commercialUsageReservation.count()).toBe(1);
  });

  it.each(["existing_id", "other_container", "other_tenant"])("never overwrites %s with the late response metadata", async guard => {
    await publication("late_guard");
    state.wait.mockResolvedValueOnce({ status_code: "FINISHED" }).mockResolvedValueOnce({ status_code: "PUBLISHED" });
    let accepted!: (mediaId: string) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    state.publish.mockImplementationOnce(() => { entered(); return new Promise<string>(resolve => { accepted = resolve; }); });
    const first = state.processor(job("late_guard")); await started;
    let before: unknown;
    try {
      await state.processor(job("late_guard"));
      if (guard === "other_tenant") await state.db.workspace.create({ data: { id: "late_guard_other_workspace", name: "Other", ownerId: "owner" } });
      before = await state.db.scheduledPublication.update({ where: { id: "late_guard" }, data: {
        ...(guard === "existing_id" ? { metaMediaId: "already_saved_media" } : {}),
        ...(guard === "other_container" ? { metaContainerId: "different_container" } : {}),
        ...(guard === "other_tenant" ? { workspaceId: "late_guard_other_workspace" } : {}),
      } });
    } finally { accepted("late_response_must_not_override"); await first; }
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "late_guard" } })).toEqual(before);
    expect(state.publish).toHaveBeenCalledOnce();
  });

  it("preserves real publication truth and cancellation intent when a reviewed duplicate is canceled in flight", async () => {
    await state.db.speedPostBatch.create({ data: { id: "inflight_cancel", workspaceId: "workspace", instagramAccountId: "account", name: "Cancel", status: "RUNNING",
      postsPerDay: 1, scheduleMode: "FIXED", orderMode: "SEQUENTIAL", timezone: "UTC", timeSlots: ["10:00"], startsOn: new Date(), totalItems: 1 } });
    await publication("canceled_stalled_operation", "inflight_cancel");
    let accepted!: (mediaId: string) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    state.publish.mockImplementationOnce(() => { entered(); return new Promise<string>(resolve => { accepted = resolve; }); });
    const first = state.processor(job("canceled_stalled_operation")); await started;
    try {
      await expect(state.processor(job("canceled_stalled_operation"))).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
      const request = new NextRequest("http://localhost/api/publishing/batches/inflight_cancel", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
      expect((await cancelBatch(request, { params: Promise.resolve({ id: "inflight_cancel" }) })).status).toBe(200);
      expect((await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "canceled_stalled_operation" } })).status).toBe("CANCELLED");
    } finally { accepted("real_fixture_inflight_media"); await first; }
    const result = await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "canceled_stalled_operation" } });
    expect(result).toMatchObject({ status: "PUBLISHED", metaMediaId: "real_fixture_inflight_media" });
    expect(result.cancelledAt).toBeInstanceOf(Date);
    expect((await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "inflight_cancel" } })).status).toBe("CANCELLED");
    expect(state.publish).toHaveBeenCalledOnce();
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(1), reserved: BigInt(0) });
  });

  it.each(["other_error", "not_publishing", "missing_intent", "different_container", "different_tenant", "normal_cancel"])("does not overwrite unrelated cancellation state on proof: %s", async guard => {
    await publication("proof_guard");
    let accepted!: (mediaId: string) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    state.publish.mockImplementationOnce(() => { entered(); return new Promise<string>(resolve => { accepted = resolve; }); });
    const first = state.processor(job("proof_guard")); await started;
    let before: unknown;
    try {
      if (guard === "different_tenant") await state.db.workspace.create({ data: { id: "workspace_other", name: "Other", ownerId: "owner" } });
      before = await state.db.scheduledPublication.update({ where: { id: "proof_guard" }, data: {
        status: "CANCELLED",
        lastError: guard === "other_error" ? "UNRELATED_FAILURE" : guard === "normal_cancel" ? null : "PUBLICATION_OUTCOME_REVIEW_REQUIRED",
        metaStatus: guard === "not_publishing" ? "IN_PROGRESS" : "PUBLISHING",
        cancelledAt: guard === "missing_intent" ? null : new Date(),
        ...(guard === "different_container" ? { metaContainerId: "other_container" } : {}),
        ...(guard === "different_tenant" ? { workspaceId: "workspace_other" } : {}),
      } });
    } finally { accepted("fixture_real_guarded_media"); await first; }
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "proof_guard" } })).toEqual(before);
    expect(state.publish).toHaveBeenCalledOnce();
  });

  it("does not restart an ordinarily canceled job without any provider proof", async () => {
    await publication("ordinary_cancel");
    const before = await state.db.scheduledPublication.update({ where: { id: "ordinary_cancel" }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await state.processor(job("ordinary_cancel"));
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "ordinary_cancel" } })).toEqual(before);
    expect(state.wait).not.toHaveBeenCalled(); expect(state.publish).not.toHaveBeenCalled();
    expect(await state.db.commercialUsageReservation.count()).toBe(0);
  });

  it.each(["RESERVED", "REJECTED"])("releases a %s hold when a failed publication is canceled after expiry", async status => {
    await publication("cancel_held"); const id = await allowance("cancel_held");
    if (status === "REJECTED") {
      const claim = await beginCommercialDispatch("workspace", id);
      await finishCommercialDispatch("workspace", id, claim!.dispatchToken, "DEFINITELY_REJECTED");
    }
    await state.db.scheduledPublication.update({ where: { id: "cancel_held" }, data: { status: "FAILED", lastError: "USAGE_RESERVATION_STALE" } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(trialEndsAt.getTime() + 1);
    const request = new NextRequest("http://localhost/api/publishing/publications?id=cancel_held", { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
    expect((await cancelPublication(request)).status).toBe(200);
    expect(await state.db.commercialUsageReservation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "RELEASED" });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(0), reserved: BigInt(0) });
    expect(state.publish).not.toHaveBeenCalled();
  });

  it.each(["HTTP", "MCP"])("%s batch cancellation releases only unused/rejected holds and preserves uncertain/confirmed evidence", async transport => {
    await state.db.speedPostBatch.create({ data: { id: "cancel_batch", workspaceId: "workspace", instagramAccountId: "account", name: "Cancel", status: "RUNNING",
      postsPerDay: 1, scheduleMode: "FIXED", orderMode: "SEQUENTIAL", timezone: "UTC", timeSlots: ["10:00"], startsOn: new Date(), totalItems: 4 } });
    const identities = ["reserved", "rejected", "unknown", "committed"];
    const reservations: string[] = [];
    for (const key of identities) {
      await publication(key, "cancel_batch");
      await state.db.scheduledPublication.update({ where: { id: key }, data: { status: key === "committed" ? "PUBLISHED" : "FAILED" } });
      const id = await allowance(key); reservations.push(id);
      if (key !== "reserved") {
        const claim = await beginCommercialDispatch("workspace", id);
        if (key !== "unknown") await finishCommercialDispatch("workspace", id, claim!.dispatchToken, key === "rejected" ? "DEFINITELY_REJECTED" : "CONFIRMED");
      }
    }
    const request = new NextRequest("http://localhost/api/publishing/batches/cancel_batch", { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
    if (transport === "HTTP") expect((await cancelBatch(request, { params: Promise.resolve({ id: "cancel_batch" }) })).status).toBe(200);
    else expect(await createPrismaMcpPublishingService("workspace").manageBatch("cancel_batch", "cancel")).toMatchObject({ status: "CANCELLED" });
    for (let i = 0; i < identities.length; i++) expect((await state.db.commercialUsageReservation.findUniqueOrThrow({ where: { id: reservations[i] } })).status)
      .toBe(["RELEASED", "RELEASED", "DISPATCHING", "COMMITTED"][i]);
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(1), reserved: BigInt(1) });
    expect((await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "committed" } })).status).toBe("PUBLISHED");
    expect(state.publish).not.toHaveBeenCalled();
  });

  it("rolls the cancellation back together with its hold when quota cleanup fails", async () => {
    await publication("cancel_rollback"); const id = await allowance("cancel_rollback");
    await state.db.scheduledPublication.update({ where: { id: "cancel_rollback" }, data: { status: "FAILED" } });
    const original = state.db;
    state.db = original.$extends({ query: { commercialUsageBucket: {
      async update() { throw new Error("fixture cleanup persistence failure"); },
    } } }) as unknown as PrismaClient;
    try {
      const request = new NextRequest("http://localhost/api/publishing/publications?id=cancel_rollback", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
      await expect(cancelPublication(request)).rejects.toThrow("fixture cleanup persistence failure");
    } finally { state.db = original; }
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "cancel_rollback" } })).toMatchObject({ status: "FAILED", cancelledAt: null });
    expect(await state.db.commercialUsageReservation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "RESERVED" });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(0), reserved: BigInt(1) });
  });

  it("rolls MCP batch, publications and quota cleanup back together if a write fails", async () => {
    await state.db.speedPostBatch.create({ data: { id: "mcp_rollback", workspaceId: "workspace", instagramAccountId: "account", name: "Rollback", status: "RUNNING",
      postsPerDay: 1, scheduleMode: "FIXED", orderMode: "SEQUENTIAL", timezone: "UTC", timeSlots: ["10:00"], startsOn: new Date(), totalItems: 1 } });
    await publication("mcp_held", "mcp_rollback"); const id = await allowance("mcp_held");
    await state.db.scheduledPublication.update({ where: { id: "mcp_held" }, data: { status: "FAILED" } });
    const original = state.db;
    state.db = original.$extends({ query: { commercialUsageBucket: {
      async update() { throw new Error("fixture MCP cleanup persistence failure"); },
    } } }) as unknown as PrismaClient;
    try {
      await expect(createPrismaMcpPublishingService("workspace").manageBatch("mcp_rollback", "cancel")).rejects.toThrow("fixture MCP cleanup persistence failure");
    } finally { state.db = original; }
    expect(await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "mcp_rollback" } })).toMatchObject({ status: "RUNNING", cancelledAt: null });
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "mcp_held" } })).toMatchObject({ status: "FAILED", cancelledAt: null });
    expect(await state.db.commercialUsageReservation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "RESERVED" });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(0), reserved: BigInt(1) });
  });

  it("adds no MCP cancellation usage/publication reads when billing is disabled", async () => {
    await state.db.speedPostBatch.create({ data: { id: "mcp_legacy", workspaceId: "workspace", instagramAccountId: "account", name: "Legacy", status: "RUNNING",
      postsPerDay: 1, scheduleMode: "FIXED", orderMode: "SEQUENTIAL", timezone: "UTC", timeSlots: ["10:00"], startsOn: new Date(), totalItems: 1 } });
    await publication("mcp_legacy_item", "mcp_legacy"); vi.stubEnv("BILLING_ENABLED", "false");
    let addedQueries = 0;
    const original = state.db;
    state.db = original.$extends({ query: {
      commercialUsageReservation: { async findMany({ args, query }) { addedQueries++; return query(args); } },
      scheduledPublication: { async findMany({ args, query }) { addedQueries++; return query(args); } },
    } }) as unknown as PrismaClient;
    try { expect(await createPrismaMcpPublishingService("workspace").manageBatch("mcp_legacy", "cancel")).toMatchObject({ status: "CANCELLED" }); }
    finally { state.db = original; }
    expect(addedQueries).toBe(0);
    expect((await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "mcp_legacy_item" } })).status).toBe("CANCELLED");
  });

  it("does not view or release another workspace's batch holds through MCP", async () => {
    await state.db.speedPostBatch.create({ data: { id: "mcp_scoped", workspaceId: "workspace", instagramAccountId: "account", name: "Scoped", status: "RUNNING",
      postsPerDay: 1, scheduleMode: "FIXED", orderMode: "SEQUENTIAL", timezone: "UTC", timeSlots: ["10:00"], startsOn: new Date(), totalItems: 1 } });
    await publication("mcp_scoped_item", "mcp_scoped"); const id = await allowance("mcp_scoped_item");
    await expect(createPrismaMcpPublishingService("foreign_workspace").manageBatch("mcp_scoped", "cancel")).rejects.toThrow("Batch not found in the authorized workspace");
    expect(await state.db.commercialUsageReservation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "RESERVED" });
    expect((await state.db.speedPostBatch.findUniqueOrThrow({ where: { id: "mcp_scoped" } })).status).toBe("RUNNING");
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ reserved: BigInt(1), consumed: BigInt(0) });
  });

  it("retains unknown outcomes across replays and commits only canonical PUBLISHED recovery after expiry", async () => {
    await publication("unknown");
    state.publish.mockRejectedValueOnce(new TypeError("fixture network interruption"));
    await expect(state.processor(job("unknown"))).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
    expect(await state.db.commercialUsageReservation.findFirstOrThrow()).toMatchObject({ status: "DISPATCHING" });
    await state.db.scheduledPublication.update({ where: { id: "unknown" }, data: { status: "QUEUED" } });
    await expect(state.processor(job("unknown"))).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
    expect(state.publish).toHaveBeenCalledOnce();
    await state.db.scheduledPublication.update({ where: { id: "unknown" }, data: { status: "QUEUED" } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(trialEndsAt.getTime() + 1);
    state.wait.mockResolvedValue({ status_code: "PUBLISHED" });
    await state.processor(job("unknown")); await state.processor(job("unknown"));
    expect(state.publish).toHaveBeenCalledOnce();
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(1), reserved: BigInt(0) });
    expect(await state.db.commercialUsageReservation.findFirstOrThrow()).toMatchObject({ status: "COMMITTED" });
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "unknown" } })).toMatchObject({ status: "PUBLISHED", metaStatus: "PUBLISHED_RECOVERED", metaMediaId: null });
  });

  it("holds a missing publish receipt as unknown until Meta canonical PUBLISHED recovery", async () => {
    await publication("missing_receipt"); state.publish.mockResolvedValueOnce(undefined);
    await expect(state.processor(job("missing_receipt"))).rejects.toThrow("PUBLICATION_OUTCOME_REVIEW_REQUIRED");
    expect(await state.db.commercialUsageReservation.findFirstOrThrow()).toMatchObject({ status: "DISPATCHING" });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(0), reserved: BigInt(1) });
    expect((await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "missing_receipt" } })).status).toBe("FAILED");
    await state.db.scheduledPublication.update({ where: { id: "missing_receipt" }, data: { status: "QUEUED" } });
    state.wait.mockResolvedValue({ status_code: "PUBLISHED" }); await state.processor(job("missing_receipt"));
    expect(state.publish).toHaveBeenCalledOnce();
    expect(await state.db.commercialUsageReservation.findFirstOrThrow()).toMatchObject({ status: "COMMITTED" });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(1), reserved: BigInt(0) });
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "missing_receipt" } })).toMatchObject({ status: "PUBLISHED", metaStatus: "PUBLISHED_RECOVERED" });
  });

  it("retries a proven rate-limit rejection in the last slot and recovers a lost local write without another allocation", async () => {
    const previous = await allowance("previous_usage", 9), previousClaim = await beginCommercialDispatch("workspace", previous);
    await finishCommercialDispatch("workspace", previous, previousClaim!.dispatchToken, "CONFIRMED");
    await publication("retry_rejected");
    const rejection = new RateLimitError("fixture Meta rejection");
    state.publish.mockRejectedValueOnce(rejection);
    await expect(state.processor(job("retry_rejected"))).rejects.toBe(rejection);
    const rejected = await state.db.commercialUsageReservation.findFirstOrThrow({ where: { operationKey: "retry_rejected" } });
    expect(rejected.status).toBe("REJECTED");
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ reserved: BigInt(0), consumed: BigInt(9) });
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "retry_rejected" } })).toMatchObject({ status: "PROCESSING" });

    const updateMany = state.db.scheduledPublication.updateMany.bind(state.db.scheduledPublication);
    let lostWrite = false;
    vi.spyOn(state.db.scheduledPublication, "updateMany").mockImplementation(args => {
      if (args.data.status === "PUBLISHED" && !lostWrite) { lostWrite = true; throw new Error("fixture local publication write lost"); }
      return updateMany(args);
    });
    await expect(state.processor(job("retry_rejected"))).rejects.toThrow("fixture local publication write lost");
    expect(await state.db.commercialUsageReservation.findFirstOrThrow({ where: { operationKey: "retry_rejected" } })).toMatchObject({ id: rejected.id, status: "COMMITTED" });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ reserved: BigInt(0), consumed: BigInt(10) });
    expect(await state.db.commercialUsageReservation.count()).toBe(2);

    // The successful effect is already charged, and now every allowance is
    // used. Canonical recovery still needs no fresh reservation/access grant.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(trialEndsAt.getTime() + 1);
    state.wait.mockResolvedValue({ status_code: "PUBLISHED" });
    await state.processor(job("retry_rejected")); await state.processor(job("retry_rejected"));
    expect(state.publish).toHaveBeenCalledTimes(2); // one rejection, one success
    expect(await state.db.commercialUsageReservation.count()).toBe(2);
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ reserved: BigInt(0), consumed: BigInt(10) });
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "retry_rejected" } })).toMatchObject({ status: "PUBLISHED" });
  });

  it("honors a cancellation committed during container processing and returns the unused hold", async () => {
    await state.db.speedPostBatch.create({ data: { id: "batch", workspaceId: "workspace", instagramAccountId: "account", name: "Test", status: "RUNNING",
      postsPerDay: 1, scheduleMode: "FIXED", orderMode: "SEQUENTIAL", timezone: "UTC", timeSlots: ["10:00"], startsOn: new Date(), totalItems: 1 } });
    await publication("cancelled", "batch");
    state.wait.mockImplementationOnce(async () => {
      await state.db.speedPostBatch.update({ where: { id: "batch" }, data: { status: "CANCELLED" } });
      return { status_code: "FINISHED" };
    });
    await state.processor(job("cancelled"));
    expect(state.publish).not.toHaveBeenCalled();
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "cancelled" } })).toMatchObject({ status: "CANCELLED" });
    expect(await state.db.commercialUsageReservation.findFirstOrThrow()).toMatchObject({ status: "RELEASED" });
    expect(await state.db.commercialUsageBucket.findFirstOrThrow()).toMatchObject({ consumed: BigInt(0), reserved: BigInt(0) });
  });

  it("rechecks the actual trial clock after waiting without reserving or publishing", async () => {
    await publication("expired");
    state.wait.mockImplementationOnce(async () => {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(trialEndsAt.getTime() + 1);
      return { status_code: "FINISHED" };
    });
    await expect(state.processor(job("expired"))).rejects.toThrow("COMMERCIAL_ACCESS_REQUIRED");
    expect(state.publish).not.toHaveBeenCalled();
    expect(await state.db.commercialUsageReservation.count()).toBe(0);
    expect(await state.db.scheduledPublication.findUniqueOrThrow({ where: { id: "expired" } })).toMatchObject({ status: "FAILED", metaContainerId: "container_expired" });
  });

  it("performs no commercial database transaction when billing is disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false"); await publication("legacy");
    const transaction = vi.spyOn(state.db, "$transaction");
    await state.processor(job("legacy"));
    expect(transaction).not.toHaveBeenCalled();
    expect(state.publish).toHaveBeenCalledOnce();
    expect(await state.db.commercialUsageReservation.count()).toBe(0);
  });
});
