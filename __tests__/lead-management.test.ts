import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(), campaign: vi.fn(), listLinks: vi.fn(), updateLink: vi.fn(),
  findLead: vi.fn(), listLeads: vi.fn(), deleteLead: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    automation: { findFirst: mocks.campaign },
    trackedLink: { findMany: mocks.listLinks, updateMany: mocks.updateLink },
    campaignLead: { findFirst: mocks.findLead, findMany: mocks.listLeads, deleteMany: mocks.deleteLead },
  },
}));
vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: (role: string) => role === "ADMIN" || role === "OWNER",
  getCurrentWorkspaceContext: mocks.workspace,
}));

import { DELETE, GET, PATCH } from "@/app/api/automations/[id]/leads/route";
import { encryptLeadContact } from "@/lib/tracking/lead-capture";

const route = { params: Promise.resolve({ id: "campaign1" }) };
const endpoint = "https://app.example/api/automations/campaign1/leads";
const lead = "e3375e7f-42f0-4fd1-9f59-d7f5895f9ac2";
const link = "cnow000000000000000000000";
const contact = { name: "Ana Teste", email: "ana@example.com", phone: "41999990000" };
const scope = { workspaceId: "workspace1", automationId: "campaign1" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
  mocks.workspace.mockResolvedValue({ workspaceId: scope.workspaceId, role: "ADMIN" });
  mocks.campaign.mockResolvedValue({ id: scope.automationId });
  mocks.listLinks.mockResolvedValue([]);
  mocks.listLeads.mockResolvedValue([]);
  mocks.updateLink.mockResolvedValue({ count: 1 });
  mocks.deleteLead.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe("lead management", () => {
  it("denies unauthenticated or member sessions and campaigns outside the workspace", async () => {
    mocks.workspace.mockResolvedValueOnce(null).mockResolvedValueOnce({ workspaceId: "workspace1", role: "MEMBER" });
    expect((await GET(new NextRequest(endpoint), route)).status).toBe(401);
    expect((await GET(new NextRequest(endpoint), route)).status).toBe(403);
    mocks.campaign.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest(endpoint), route)).status).toBe(404);
    expect(mocks.listLeads).not.toHaveBeenCalled();
    expect(mocks.campaign).toHaveBeenCalledExactlyOnceWith({
      where: { id: scope.automationId, workspaceId: scope.workspaceId }, select: { id: true },
    });
  });

  it("returns only authorized decrypted data and scopes the cursor", async () => {
    const createdAt = new Date("2026-11-27T13:15:00Z");
    mocks.listLeads.mockResolvedValue([{ id: lead, sourceLinkId: link, createdAt, contactCiphertext: encryptLeadContact(contact) }]);
    const response = await GET(new NextRequest(endpoint), route);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      leads: [{ ...contact, id: lead, sourceLinkId: link, createdAt: createdAt.toISOString() }],
      links: [], nextCursor: null,
    });
    mocks.findLead.mockResolvedValue(null);
    expect((await GET(new NextRequest(`${endpoint}?cursor=${lead}`), route)).status).toBe(400);
    expect(mocks.findLead.mock.calls[0][0].where).toEqual({ ...scope, id: lead });
    expect(mocks.listLeads.mock.calls[0][0].where).toEqual(scope);
    expect(mocks.listLeads).toHaveBeenCalledOnce();
  });

  it("scopes edits and deletions to the authenticated campaign and workspace", async () => {
    const request = new NextRequest(endpoint, {
      method: "PATCH", body: JSON.stringify({ linkId: link, requireLead: true }),
    });
    expect((await PATCH(request, route)).status).toBe(200);
    expect(mocks.updateLink).toHaveBeenCalledExactlyOnceWith({
      where: { ...scope, id: link }, data: { requireLead: true },
    });
    const deletion = new NextRequest(`${endpoint}?id=${lead}`, { method: "DELETE" });
    expect((await DELETE(deletion, route)).status).toBe(200);
    expect(mocks.deleteLead).toHaveBeenCalledExactlyOnceWith({ where: { ...scope, id: lead } });
  });
});
