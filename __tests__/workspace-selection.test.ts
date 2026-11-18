import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ enabled: true }));
const mocks = vi.hoisted(() => ({
  userId: vi.fn(), transaction: vi.fn(),
  user: { findUnique: vi.fn(), update: vi.fn() },
  member: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/billing/trial", () => ({ isBillingEnabled: () => state.enabled }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: mocks.userId }));
vi.mock("@/lib/db/client", () => ({ prisma: { user: mocks.user, workspaceMember: mocks.member, $transaction: mocks.transaction } }));

import { getSelectedWorkspaceMembership } from "@/lib/workspace-selection";
import { GET, POST } from "@/app/api/workspace/selection/route";

const member = { id: "membership", workspaceId: "workspace-a", userId: "alice", role: "MEMBER", workspace: { id: "workspace-a", name: "Workspace A", ownerId: "never expose" } };
function request(body = JSON.stringify({ workspaceId: "workspace-a" }), origin: string | null = "https://app.example.test", extra: Record<string, string> = {}) {
  return new NextRequest("https://app.example.test/api/workspace/selection", { method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), ...extra }, body });
}
beforeEach(() => {
  vi.resetAllMocks(); state.enabled = true;
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.test"); vi.stubEnv("AUTH_URL", "");
  mocks.userId.mockResolvedValue("alice"); mocks.user.findUnique.mockResolvedValue({ activeWorkspaceId: null });
  mocks.member.findFirst.mockResolvedValue(member); mocks.member.findUnique.mockResolvedValue(member);
  mocks.member.findMany.mockResolvedValue([member]); mocks.user.update.mockResolvedValue({ id: "alice" });
  mocks.transaction.mockImplementation(async operation => operation({ user: mocks.user, workspaceMember: mocks.member }));
});
afterEach(() => vi.unstubAllEnvs());

describe("workspace preference resolver", () => {
  it("returns the oldest membership without selecting the new column in legacy mode", async () => {
    state.enabled = false;
    expect(await getSelectedWorkspaceMembership("alice")).toEqual(member);
    expect(mocks.user.findUnique).not.toHaveBeenCalled(); expect(mocks.member.findUnique).not.toHaveBeenCalled();
    expect(mocks.member.findFirst).toHaveBeenCalledExactlyOnceWith({ where: { userId: "alice" }, include: { workspace: true }, orderBy: { createdAt: "asc" } });
  });
  it("requires real membership in the preference, including the authenticated user", async () => {
    mocks.user.findUnique.mockResolvedValue({ activeWorkspaceId: "workspace-a" });
    expect(await getSelectedWorkspaceMembership("alice")).toEqual(member);
    expect(mocks.member.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { workspaceId_userId: { workspaceId: "workspace-a", userId: "alice" } }, include: { workspace: true },
    });
    expect(mocks.member.findFirst).not.toHaveBeenCalled();
  });
  it("falls back after revocation and never recreates or elevates membership", async () => {
    mocks.user.findUnique.mockResolvedValue({ activeWorkspaceId: "workspace-b" }); mocks.member.findUnique.mockResolvedValue(null);
    expect(await getSelectedWorkspaceMembership("alice")).toEqual(member);
    expect(mocks.member.findFirst).toHaveBeenCalledOnce(); expect(mocks.user.update).not.toHaveBeenCalled();
  });
});

describe("workspace selection HTTP contract", () => {
  it("disables both endpoints before auth/body/database access", async () => {
    state.enabled = false; const req = request(), reader = vi.spyOn(req.body!, "getReader");
    for (const response of [await GET(), await POST(req)]) {
      expect(response.status).toBe(404); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(mocks.userId).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
    expect(mocks.user.findUnique).not.toHaveBeenCalled(); expect(mocks.member.findMany).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("requires authentication before reading POST body", async () => {
    mocks.userId.mockResolvedValue(null); const req = request(), reader = vi.spyOn(req.body!, "getReader");
    expect((await GET()).status).toBe(401); expect((await POST(req)).status).toBe(401);
    expect(reader).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([null, "null", "https://attacker.example"])("requires an explicit trusted Origin: %s", async origin => {
    const req = request(undefined, origin), reader = vi.spyOn(req.body!, "getReader");
    expect((await POST(req)).status).toBe(403); expect(reader).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("returns only the membership/workspace allowlist", async () => {
    const response = await GET(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { activeWorkspaceId: "workspace-a", activeWorkspaceName: "Workspace A", workspaces: [{ id: "workspace-a", name: "Workspace A", role: "MEMBER" }] } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.member.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "alice" }, select: { role: true, workspace: { select: { id: true, name: true } } } }));
  });
  it.each(["OWNER", "ADMIN", "MEMBER"])("permits %s selection without changing their authority", async role => {
    mocks.member.findUnique.mockResolvedValue({ ...member, role });
    const response = await POST(request()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { id: "workspace-a", name: "Workspace A", role } });
    expect(mocks.user.update).toHaveBeenCalledExactlyOnceWith({ where: { id: "alice" }, data: { activeWorkspaceId: "workspace-a" }, select: { id: true } });
  });
  it("returns an empty list when the user has no workspace", async () => {
    mocks.member.findFirst.mockResolvedValue(null); mocks.member.findMany.mockResolvedValue([]);
    expect(await (await GET()).json()).toEqual({ success: true, data: { activeWorkspaceId: null, activeWorkspaceName: null, workspaces: [] } });
  });
  it("hides foreign/nonexistent workspace details and never changes preferences", async () => {
    mocks.member.findUnique.mockResolvedValue(null);
    const response = await POST(request(JSON.stringify({ workspaceId: "foreign" })));
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ success: false, error: "NOT_FOUND" });
    expect(mocks.member.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId_userId: { workspaceId: "foreign", userId: "alice" } } }));
    expect(mocks.user.update).not.toHaveBeenCalled();
  });
  it.each(["not JSON", "{}", '{"workspaceId":""}', '{"workspaceId":1}', '{"workspaceId":"workspace-a","userId":"bob"}', '{"workspaceId":"workspace-a","role":"OWNER"}'])("rejects malformed/extra request fields: %s", async body => {
    const response = await POST(request(body)); expect(response.status).toBe(400); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["declared", "streamed", "unicode"])("bounds %s body bytes before parsing", async mode => {
    const body = mode === "unicode" ? JSON.stringify({ workspaceId: "é".repeat(2500) }) : JSON.stringify({ workspaceId: "x".repeat(mode === "declared" ? 1 : 5000) });
    const req = request(body, undefined, { "Content-Length": mode === "declared" ? "4097" : "1" });
    expect((await POST(req)).status).toBe(413); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("accepts valid JSON at the exact 4096-byte boundary", async () => {
    expect((await POST(request(JSON.stringify({ workspaceId: "workspace-a" }).padEnd(4096, " ")))).status).toBe(200);
  });
  it("redacts internal failures and keeps errors private", async () => {
    mocks.user.update.mockRejectedValue(new Error("postgres://private-secret/customer-token"));
    const response = await POST(request()); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: "WORKSPACE_SELECTION_UNAVAILABLE" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
