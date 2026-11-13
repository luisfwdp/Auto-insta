import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ role: "MEMBER" as "MEMBER" | "ADMIN" | "OWNER" }));
const sendDirectMessage = vi.hoisted(() => vi.fn());
const getWorkspaceInstagramAccount = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: vi.fn(async () => "workspace_1"),
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => ({
    userId: "user_1",
    workspaceId: "workspace_1",
    workspace: { id: "workspace_1" },
    role: state.role,
  })),
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

vi.mock("@/lib/instagram-accounts", () => ({
  getWorkspaceInstagramAccount,
}));

vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn(),
  getConversations: vi.fn(),
  sendDirectMessage,
  MetaApiError: class MetaApiError extends Error {},
}));

import { POST } from "@/app/api/instagram/conversations/route";

describe("conversation send RBAC", () => {
  beforeEach(() => {
    state.role = "MEMBER";
    sendDirectMessage.mockReset();
    getWorkspaceInstagramAccount.mockReset();
  });

  it("rejects members before reading an Instagram account or sending a DM", async () => {
    const response = await POST(new NextRequest("http://localhost/api/instagram/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramAccountId: "account_1", recipientId: "recipient_1", text: "Olá" }),
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Only workspace owners and admins can send messages.",
    });
    expect(getWorkspaceInstagramAccount).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });
});
