import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  context: { workspaceId: "workspace_b", role: "OWNER", userId: "user_b", workspace: {} },
  prisma: {
    scheduledPublication: { findMany: vi.fn(), findFirst: vi.fn() },
    speedPostBatch: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => state.context),
  canManageWorkspace: vi.fn(() => true),
}));
vi.mock("@/lib/db/client", () => ({ prisma: state.prisma }));

import * as publicationsRoute from "@/app/api/publishing/publications/route";
import * as batchesRoute from "@/app/api/publishing/batches/route";
import * as batchRoute from "@/app/api/publishing/batches/[id]/route";

beforeEach(() => {
  vi.clearAllMocks();
  state.prisma.scheduledPublication.findMany.mockResolvedValue([]);
  state.prisma.speedPostBatch.findMany.mockResolvedValue([]);
  state.prisma.speedPostBatch.findFirst.mockResolvedValue(null);
});

describe("publishing workspace isolation", () => {
  it("scopes publication filters to the server-derived workspace", async () => {
    await publicationsRoute.GET(new NextRequest("http://localhost/api/publishing/publications?instagramAccountId=account_a&batchId=batch_a"));
    expect(state.prisma.scheduledPublication.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "workspace_b", instagramAccountId: "account_a", batchId: "batch_a" }),
    }));
  });

  it("scopes batch lists and client-supplied batch IDs", async () => {
    await batchesRoute.GET(new NextRequest("http://localhost/api/publishing/batches?instagramAccountId=account_a"));
    expect(state.prisma.speedPostBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace_b", instagramAccountId: "account_a" },
    }));

    const response = await batchRoute.GET(new NextRequest("http://localhost/api/publishing/batches/batch_a"), { params: Promise.resolve({ id: "batch_a" }) });
    expect(response.status).toBe(404);
    expect(state.prisma.speedPostBatch.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "batch_a", workspaceId: "workspace_b" } }));
  });
});
