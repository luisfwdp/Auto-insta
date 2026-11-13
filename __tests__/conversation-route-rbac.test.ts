import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ role: "MEMBER" as "MEMBER" | "ADMIN" | "OWNER" }));
const sendDirectMessage = vi.hoisted(() => vi.fn());
const getWorkspaceInstagramAccount = vi.hoisted(() => vi.fn());
const checkManualDmRateLimit = vi.hoisted(() => vi.fn());
const createAuditEvent = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/api/manual-dm-rate-limit", () => ({
  checkManualDmRateLimit,
}));

vi.mock("@/lib/db/client", () => ({
  prisma: { operationalEvent: { create: createAuditEvent } },
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
    checkManualDmRateLimit.mockReset();
    createAuditEvent.mockReset();
    createAuditEvent.mockResolvedValue({});
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

  it("rate limits an admin before sending and records a content-free audit event", async () => {
    state.role = "ADMIN";
    getWorkspaceInstagramAccount.mockResolvedValue({
      id: "account_1",
      instagramId: "ig_1",
    });
    checkManualDmRateLimit.mockResolvedValue({ allowed: false, retryAfter: 45 });

    const response = await POST(new NextRequest("http://localhost/api/instagram/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instagramAccountId: "account_1",
        recipientId: "recipient_secret",
        text: "mensagem secreta",
      }),
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(createAuditEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        level: "WARNING",
        payload: {
          userId: "user_1",
          instagramAccountId: "account_1",
          outcome: "RATE_LIMITED",
          messageLength: 16,
        },
      }),
    });
    const audit = JSON.stringify(createAuditEvent.mock.calls);
    expect(audit).not.toContain("mensagem secreta");
    expect(audit).not.toContain("recipient_secret");
  });

  it("fails closed when the Redis rate limiter is unavailable", async () => {
    state.role = "OWNER";
    getWorkspaceInstagramAccount.mockResolvedValue({
      id: "account_1",
      instagramId: "ig_1",
    });
    checkManualDmRateLimit.mockRejectedValue(new Error("Redis unavailable"));

    const response = await POST(new NextRequest("http://localhost/api/instagram/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientId: "recipient_1", text: "Olá" }),
    }));

    expect(response.status).toBe(503);
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(createAuditEvent).not.toHaveBeenCalled();
  });
});
