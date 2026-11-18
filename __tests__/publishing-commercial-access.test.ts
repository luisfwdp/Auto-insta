import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  access: vi.fn(), transaction: vi.fn(), account: vi.fn(), assets: vi.fn(),
  publication: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  batch: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("@/lib/billing/commercial-access", () => ({ assertCommercialAccess: mocks.access }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => ({ workspaceId: "workspace", role: "OWNER" })),
  canManageWorkspace: vi.fn(() => true),
}));
vi.mock("@/lib/db/client", () => ({ prisma: {
  scheduledPublication: mocks.publication, speedPostBatch: mocks.batch,
  instagramAccount: { findFirst: mocks.account }, publishingAsset: { findMany: mocks.assets },
  $transaction: mocks.transaction,
} }));

import * as publications from "@/app/api/publishing/publications/route";
import * as batches from "@/app/api/publishing/batches/route";
import * as batch from "@/app/api/publishing/batches/[id]/route";
import { createPrismaMcpPublishingService, registerPublishingTools } from "@/lib/mcp/publishing-tools";
import { BillingError } from "@/lib/billing/config";
import { createBatchSchema, publicationInputSchema } from "@/lib/publishing/schemas";
import type { McpServer } from "@modelcontextprotocol/server";

const publication = {
  id: "publication", workspaceId: "workspace", instagramAccountId: "account", status: "DRAFT",
  type: "REEL", reelMode: "STANDARD", caption: "Caption", scheduledFor: null, timezone: "UTC",
  metaContainerId: null, assets: [{ assetId: "asset", position: 0 }],
};
const publicationInput = publicationInputSchema.parse({
  instagramAccountId: "account", type: "REEL", assetIds: ["asset"], timezone: "UTC",
  scheduledFor: "2030-01-01T10:00:00Z",
});
const batchInput = createBatchSchema.parse({
  instagramAccountId: "account", name: "Batch", items: [{ assetId: "asset" }],
  timezone: "UTC", postsPerDay: 1, scheduleMode: "FIXED", orderMode: "SEQUENTIAL",
  timeSlots: ["10:00"], startsOn: "2030-01-01",
});
const params = { params: Promise.resolve({ id: "batch" }) };
function request(path: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost/api/publishing/${path}`, { method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockRejectedValue(new BillingError("COMMERCIAL_ACCESS_REQUIRED", 402));
  mocks.account.mockResolvedValue({ id: "account" });
  mocks.assets.mockResolvedValue([{ id: "asset", mediaType: "VIDEO", filename: "video.mp4" }]);
  mocks.publication.findFirst.mockResolvedValue(publication);
  mocks.publication.findMany.mockResolvedValue([]);
  mocks.publication.findUnique.mockResolvedValue(publication);
  mocks.publication.create.mockResolvedValue(publication);
  mocks.publication.updateMany.mockResolvedValue({ count: 1 });
  mocks.batch.findFirst.mockResolvedValue({ id: "batch", workspaceId: "workspace", status: "PAUSED" });
  mocks.batch.findMany.mockResolvedValue([]);
  mocks.batch.findUnique.mockResolvedValue({ id: "batch" });
  mocks.batch.create.mockResolvedValue({ id: "batch" });
  mocks.batch.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(async operation => operation({ scheduledPublication: mocks.publication, speedPostBatch: mocks.batch }));
});

describe("commercial publishing HTTP access", () => {
  it("blocks creating future publications without allocating any usage reservation", async () => {
    const response = await publications.POST(request("publications", "POST", publicationInput));
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ success: false, error: "COMMERCIAL_ACCESS_REQUIRED" });
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith("workspace");
    expect(mocks.publication.create).not.toHaveBeenCalled();
  });

  it.each(["schedule", "reschedule", "publish"])("blocks publication %s before mutation", async action => {
    const response = await publications.PATCH(request("publications?id=publication", "PATCH", { action, scheduledFor: "2030-01-01T10:00:00Z" }));
    expect(response.status).toBe(402);
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith("workspace");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("blocks content changes without allowing expired draft usage", async () => {
    expect((await publications.PATCH(request("publications?id=publication", "PATCH", { caption: "Changed" }))).status).toBe(402);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("blocks creating and resuming Speed Post", async () => {
    expect((await batches.POST(request("batches", "POST", batchInput))).status).toBe(402);
    expect((await batch.PATCH(request("batches/batch", "PATCH", { action: "resume" }), params)).status).toBe(402);
    expect(mocks.batch.create).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["pause", "cancel"])("permits Speed Post %s without active billing", async action => {
    mocks.batch.findFirst.mockResolvedValue({ id: "batch", status: "RUNNING" });
    expect((await batch.PATCH(request("batches/batch", "PATCH", { action }), params)).status).toBe(200);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("permits publication DELETE/cancel without active billing", async () => {
    expect((await publications.DELETE(request("publications?id=publication", "DELETE"))).status).toBe(200);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.publication.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }));
  });

  it("preserves all publication/batch history reads", async () => {
    expect((await publications.GET(request("publications"))).status).toBe(200);
    expect((await batches.GET(request("batches"))).status).toBe(200);
    expect((await batch.GET(request("batches/batch"), params)).status).toBe(200);
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it("creates future jobs without consuming publication quota when access is allowed", async () => {
    mocks.access.mockResolvedValue(undefined);
    expect((await publications.POST(request("publications", "POST", publicationInput))).status).toBe(201);
    expect((await batches.POST(request("batches", "POST", batchInput))).status).toBe(201);
    expect(mocks.publication.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SCHEDULED" }) }));
    expect(mocks.batch.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      publications: { create: [expect.objectContaining({ status: "SCHEDULED" })] },
    }) }));
    // The mocked DB has no usage tables: schedule creation must not allocate.
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("commercial publishing MCP access", () => {
  it("blocks both creation paths and resume in the trusted workspace service", async () => {
    const service = createPrismaMcpPublishingService("workspace");
    await expect(service.createPublication(publicationInput)).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_REQUIRED" });
    await expect(service.createBatch(batchInput)).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_REQUIRED" });
    await expect(service.manageBatch("batch", "resume")).rejects.toMatchObject({ code: "COMMERCIAL_ACCESS_REQUIRED" });
    expect(mocks.access).toHaveBeenCalledTimes(3);
    for (const args of mocks.access.mock.calls) expect(args).toEqual(["workspace"]);
    expect(mocks.publication.create).not.toHaveBeenCalled();
    expect(mocks.batch.create).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("permits read, pause, cancel after expiry", async () => {
    mocks.batch.findFirst.mockResolvedValue({ id: "batch", status: "RUNNING" });
    const service = createPrismaMcpPublishingService("workspace");
    await service.listMedia(); await service.listPublications(); await service.listBatches();
    await service.manageBatch("batch", "pause"); await service.manageBatch("batch", "cancel");
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  it("returns only the safe commercial code and status through MCP", async () => {
    const registerTool = vi.fn();
    registerPublishingTools({ registerTool } as unknown as McpServer, createPrismaMcpPublishingService("workspace"));
    const handler = registerTool.mock.calls.find(([name]) => name === "create_scheduled_publication")![2];
    const result = await handler(publicationInput);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "COMMERCIAL_ACCESS_REQUIRED", status: 402 });
  });
});
