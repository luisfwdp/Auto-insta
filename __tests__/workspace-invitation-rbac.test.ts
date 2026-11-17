import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "ADMIN" as "ADMIN" | "MEMBER",
  memberRole: "OWNER" as "OWNER" | "ADMIN" | "MEMBER" | null,
  inviteConsumed: false,
  validInvitation: true,
}));
const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { upsert: vi.fn(), findMany: vi.fn() },
  workspaceInvitation: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: async () => ({ userId: "admin", workspaceId: "workspace", role: state.role }),
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));
vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: "owner", email: "owner@example.test" } }),
}));

import { POST as invite } from "@/app/api/workspace/members/route";
import { POST as accept } from "@/app/api/workspace/invitations/accept/route";

function request(path: string, body: unknown) {
  return new NextRequest(`https://app.example/api/workspace/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  state.role = "ADMIN";
  state.memberRole = "OWNER";
  state.inviteConsumed = false;
  state.validInvitation = true;
  db.user.findUnique.mockResolvedValue({ id: "owner" });
  db.workspaceMember.findMany.mockResolvedValue([]);
  db.workspaceInvitation.findMany.mockResolvedValue([]);
  db.workspaceMember.upsert.mockImplementation(async ({ create, update }) => {
    state.memberRole = state.memberRole === null ? create.role : update.role ?? state.memberRole;
    return { role: state.memberRole };
  });
  db.workspaceInvitation.findUnique.mockResolvedValue({
    id: "invitation", workspaceId: "workspace", email: "owner@example.test",
    status: "PENDING", role: "MEMBER", expiresAt: new Date(Date.now() + 60_000),
    workspace: { name: "Workspace" },
  });
  db.workspaceInvitation.updateMany.mockImplementation(async () => {
    if (!state.validInvitation || state.inviteConsumed) return { count: 0 };
    state.inviteConsumed = true;
    return { count: 1 };
  });
  db.workspaceInvitation.update.mockResolvedValue({});
  db.$transaction.mockImplementation(async (run) => typeof run === "function" ? run(db) : Promise.all(run));
});

describe("workspace invitations preserve membership authority", () => {
  it.each(["MEMBER", "ADMIN"])("an admin cannot demote an owner by inviting them as %s", async (role) => {
    const response = await invite(request("members", { email: "OWNER@example.test", role }));
    expect(response.status).toBe(200);
    expect(state.memberRole).toBe("OWNER");
  });

  it.each(["ADMIN", "MEMBER"] as const)("reinviting an existing %s cannot change their role", async (role) => {
    state.memberRole = role;
    await invite(request("members", { email: "owner@example.test", role: role === "ADMIN" ? "MEMBER" : "ADMIN" }));
    expect(state.memberRole).toBe(role);
  });

  it("still grants the requested role to a new member of the current workspace", async () => {
    state.memberRole = null;
    await invite(request("members", { email: "owner@example.test", role: "ADMIN", workspaceId: "attacker" }));
    expect(state.memberRole).toBe("ADMIN");
    expect(db.workspaceMember.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_userId: { workspaceId: "workspace", userId: "owner" } },
      create: { workspaceId: "workspace", userId: "owner", role: "ADMIN" },
    }));
  });

  it("rejects ordinary members before any membership write", async () => {
    state.role = "MEMBER";
    expect((await invite(request("members", { email: "owner@example.test", role: "ADMIN" }))).status).toBe(403);
    expect(db.workspaceMember.upsert).not.toHaveBeenCalled();
  });

  it("accepting an old invitation preserves the owner's current role", async () => {
    expect((await accept(request("invitations/accept", { token: "token" }))).status).toBe(200);
    expect(state.memberRole).toBe("OWNER");
  });

  it("a revoked or concurrently consumed invitation cannot grant membership", async () => {
    state.memberRole = null;
    state.validInvitation = false;
    expect((await accept(request("invitations/accept", { token: "token" }))).status).toBe(409);
    expect(db.workspaceMember.upsert).not.toHaveBeenCalled();
  });

  it("a valid invitation can create membership only once", async () => {
    state.memberRole = null;
    expect((await accept(request("invitations/accept", { token: "token" }))).status).toBe(200);
    expect((await accept(request("invitations/accept", { token: "token" }))).status).toBe(409);
    expect(state.memberRole).toBe("MEMBER");
    expect(db.workspaceMember.upsert).toHaveBeenCalledTimes(1);
  });
});
