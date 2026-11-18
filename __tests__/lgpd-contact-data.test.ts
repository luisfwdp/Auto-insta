import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  dmFindMany: vi.fn(), dmUpdateMany: vi.fn(),
  clickFindMany: vi.fn(), clickUpdateMany: vi.fn(),
  webhookCount: vi.fn(), webhookDeleteMany: vi.fn(),
  eventCreate: vi.fn(),
}));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.context,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));
vi.mock("@/lib/db/client", () => {
  const client = {
    dmLog: { findMany: mocks.dmFindMany, updateMany: mocks.dmUpdateMany },
    linkClick: { findMany: mocks.clickFindMany, updateMany: mocks.clickUpdateMany },
    webhookEvent: { count: mocks.webhookCount, deleteMany: mocks.webhookDeleteMany },
    operationalEvent: { create: mocks.eventCreate },
  };
  return { prisma: { ...client, $transaction: async (run: (tx: typeof client) => unknown) => run(client) } };
});

import { DELETE, GET } from "@/app/api/workspace/contact-data/route";
import { ERASED_TEXT } from "@/lib/privacy/contact-data";
import { hashRecipientId } from "@/lib/tracking/server";

const admin = { userId: "user_1", workspaceId: "ws_1", role: "ADMIN" };
const get = (query: string) => GET(new NextRequest(`https://app.test/api/workspace/contact-data?${query}`));
const erase = (body: unknown) => DELETE(new NextRequest("https://app.test/api/workspace/contact-data", {
  method: "DELETE", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue(admin);
  mocks.dmFindMany.mockResolvedValue([]);
  mocks.clickFindMany.mockResolvedValue([]);
  mocks.webhookCount.mockResolvedValue(0);
  mocks.dmUpdateMany.mockResolvedValue({ count: 2 });
  mocks.clickUpdateMany.mockResolvedValue({ count: 1 });
  mocks.webhookDeleteMany.mockResolvedValue({ count: 3 });
  mocks.eventCreate.mockResolvedValue({});
});

describe("LGPD contact data requests", () => {
  it("rejects anonymous callers and members without management role", async () => {
    mocks.context.mockResolvedValueOnce(null);
    expect((await get("commenterId=123")).status).toBe(401);
    mocks.context.mockResolvedValueOnce({ ...admin, role: "MEMBER" });
    expect((await erase({ commenterId: "123", confirm: "ERASE" })).status).toBe(403);
    expect(mocks.dmUpdateMany).not.toHaveBeenCalled();
  });

  it("exports only the session workspace's data for the contact", async () => {
    mocks.dmFindMany.mockResolvedValueOnce([{ commenterId: "123", commentText: "anon" }]);
    mocks.webhookCount.mockResolvedValueOnce(4);
    const response = await get("commenterId=123&workspaceId=other_ws");
    const body = await response.json();

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.data).toMatchObject({ contactIds: ["123"], storedWebhookEvents: 4 });
    expect(mocks.dmFindMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_1", commenterId: { in: ["123"] } });
    expect(mocks.clickFindMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_1", recipientHash: { in: [hashRecipientId("123")] } });
    expect(mocks.webhookCount.mock.calls[0][0].where.workspaceId).toBe("ws_1");
  });

  it("requires an explicit confirmation and exactly one identifier to erase", async () => {
    expect((await erase({ commenterId: "123" })).status).toBe(400);
    expect((await erase({ commenterId: "123", username: "anon", confirm: "ERASE" })).status).toBe(400);
    expect((await erase({ commenterId: "12a", confirm: "ERASE" })).status).toBe(400);
    expect(mocks.dmUpdateMany).not.toHaveBeenCalled();
  });

  it("anonymizes logs, clears click fingerprints and deletes stored payloads", async () => {
    const response = await erase({ commenterId: "123", confirm: "ERASE" });
    expect((await response.json()).data).toEqual({ interactions: 2, linkClicks: 1, webhookEvents: 3 });

    const dm = mocks.dmUpdateMany.mock.calls[0][0];
    expect(dm.where).toEqual({ workspaceId: "ws_1", commenterId: "123" });
    expect(dm.data).toMatchObject({ commenterName: null, commentText: ERASED_TEXT });
    expect(dm.data.commenterId).toMatch(/^erased:[0-9a-f]{24}$/);
    expect(mocks.clickUpdateMany.mock.calls[0][0]).toEqual({
      where: { workspaceId: "ws_1", recipientHash: { in: [hashRecipientId("123")] } },
      data: { recipientHash: null, ipHash: null, userAgent: null, referrer: null },
    });
    expect(mocks.webhookDeleteMany.mock.calls[0][0].where.workspaceId).toBe("ws_1");

    const audit = mocks.eventCreate.mock.calls[0][0].data;
    expect(audit).toMatchObject({ workspaceId: "ws_1", payload: { requestedByUserId: "user_1", contacts: 1 } });
    expect(JSON.stringify(audit)).not.toContain("123");
  });

  it("resolves a username inside the workspace and ignores already erased rows", async () => {
    mocks.dmFindMany.mockResolvedValueOnce([{ commenterId: "777" }, { commenterId: "erased:abc" }]);
    await erase({ username: "@Anon.User", confirm: "ERASE" });
    expect(mocks.dmFindMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws_1", commenterName: { equals: "anon.user", mode: "insensitive" },
    });
    expect(mocks.dmUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.dmUpdateMany.mock.calls[0][0].where.commenterId).toBe("777");
  });

  it("does nothing when the contact is unknown in this workspace", async () => {
    const response = await erase({ username: "nobody", confirm: "ERASE" });
    expect((await response.json()).data).toEqual({ interactions: 0, linkClicks: 0, webhookEvents: 0 });
    expect(mocks.dmUpdateMany).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });
});
