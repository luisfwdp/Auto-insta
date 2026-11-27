vi.mock("@/lib/api/request-rate-limit", () => ({ requestLimitResponse: vi.fn(async () => null) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(), account: vi.fn(), assets: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), transaction: vi.fn(),
}));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => ({ workspaceId: "workspace", role: "OWNER" })),
  canManageWorkspace: vi.fn(() => true),
}));
vi.mock("@/lib/db/client", () => ({ prisma: {
  scheduledPublication: { findFirst: mocks.findFirst },
  instagramAccount: { findFirst: mocks.account },
  publishingAsset: { findMany: mocks.assets },
  $transaction: mocks.transaction,
} }));

import { PATCH } from "@/app/api/publishing/publications/route";

const publication = {
  id: "publication", workspaceId: "workspace", instagramAccountId: "account",
  status: "FAILED", type: "REEL", reelMode: "STANDARD", caption: "Original caption",
  scheduledFor: new Date("2030-01-01T10:00:00Z"), timezone: "UTC",
  metaContainerId: "container", metaStatus: "PUBLISHING", metaMediaId: null,
  assets: [{ assetId: "asset", position: 0 }],
};
function request(body: unknown) {
  return new NextRequest("http://localhost/api/publishing/publications?id=publication", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(publication);
  mocks.account.mockResolvedValue({ id: "account" });
  mocks.assets.mockResolvedValue([{ id: "asset", mediaType: "VIDEO" }]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.findUnique.mockResolvedValue(publication);
  mocks.transaction.mockImplementation(async (operation) => operation({
    scheduledPublication: { updateMany: mocks.updateMany, findUnique: mocks.findUnique },
  }));
});

describe("failed publications with an existing Instagram container", () => {
  it.each([
    { caption: "New caption" }, { assetIds: ["new-asset"] },
    { instagramAccountId: "new-account" }, { type: "IMAGE_POST" }, { type: "REEL", reelMode: "TRIAL" },
  ])("rejects content/account edits before any relation or write query: %j", async (edit) => {
    const response = await PATCH(request(edit));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("already has an Instagram container");
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: publication.id, workspaceId: "workspace" }, include: { assets: true } });
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("permits a schedule-only retry without clearing the ambiguous external state", async () => {
    mocks.findFirst.mockResolvedValue({ ...publication, reelMode: "TRIAL" });
    const response = await PATCH(request({ action: "reschedule", scheduledFor: "2030-01-02T10:00:00Z", timezone: "UTC" }));
    expect(response.status).toBe(200);
    const data = mocks.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe("SCHEDULED");
    expect(data).not.toHaveProperty("metaContainerId");
    expect(data).not.toHaveProperty("metaStatus");
    expect(data).not.toHaveProperty("metaMediaId");
    expect(data.reelMode).toBeUndefined();
  });

  it("blocks content edits after a schedule-only retry has left FAILED", async () => {
    expect((await PATCH(request({ action: "reschedule", scheduledFor: "2030-01-02T10:00:00Z" }))).status).toBe(200);
    mocks.findFirst.mockResolvedValue({ ...publication, status: "SCHEDULED" });
    mocks.transaction.mockClear();
    expect((await PATCH(request({ caption: "Changed after retry" }))).status).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("cannot edit content if a container appears after the initial read", async () => {
    mocks.findFirst.mockResolvedValue({ ...publication, metaContainerId: null });
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect((await PATCH(request({ caption: "Racing content" }))).status).toBe(409);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: publication.id, workspaceId: "workspace", status: "FAILED", metaContainerId: null },
    }));
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("permits cancellation without clearing the container", async () => {
    expect((await PATCH(request({ action: "cancel" }))).status).toBe(200);
    expect(mocks.updateMany.mock.calls[0][0].data).toEqual(expect.objectContaining({ status: "CANCELLED" }));
    expect(mocks.updateMany.mock.calls[0][0].data).not.toHaveProperty("metaContainerId");
  });

  it("permits correcting content when no container has been created", async () => {
    mocks.findFirst.mockResolvedValue({ ...publication, metaContainerId: null });
    expect((await PATCH(request({ caption: "Corrected caption" }))).status).toBe(200);
    expect(mocks.updateMany.mock.calls[0][0].data.caption).toBe("Corrected caption");
  });
});
