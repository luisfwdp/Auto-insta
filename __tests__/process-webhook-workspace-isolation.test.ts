import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  eventCreate: vi.fn(),
  eventUpdateMany: vi.fn(),
  dmLogFindMany: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    instagramAccount: { findMany: mocks.accountFindMany },
    webhookEvent: {
      create: mocks.eventCreate,
      updateMany: mocks.eventUpdateMany,
    },
    dmLog: { findMany: mocks.dmLogFindMany },
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mocks.queueAdd }),
  MESSAGE_JOB_NAME: "process-message",
  POSTBACK_JOB_NAME: "process-postback",
}));
vi.mock("@/lib/meta/webhook", () => ({
  parseCommentEvents: () => [],
  parseMessageEvents: () => [],
  parsePostbackEvents: () => [],
  parseReadEvents: () => [],
}));

import { processInstagramWebhook } from "@/lib/queue/process-webhook";

describe("webhook workspace isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountFindMany.mockResolvedValue([
      { id: "connection-a", instagramId: "ig-a", workspaceId: "workspace-a" },
      { id: "connection-b", instagramId: "ig-b", workspaceId: "workspace-b" },
    ]);
    mocks.eventCreate
      .mockResolvedValueOnce({ id: "event-a" })
      .mockResolvedValueOnce({ id: "event-b" });
    mocks.eventUpdateMany.mockResolvedValue({ count: 2 });
    mocks.dmLogFindMany.mockResolvedValue([]);
  });

  it("stores one filtered event per workspace", async () => {
    const entryA = { id: "ig-a", time: 1, messaging: [] };
    const entryB = { id: "ig-b", time: 2, messaging: [] };

    await processInstagramWebhook({
      payload: { object: "instagram", entry: [entryA, entryB] },
      provider: "META",
    });

    expect(mocks.eventCreate).toHaveBeenCalledTimes(2);
    expect(mocks.eventCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace-a",
          payload: { object: "instagram", entry: [entryA] },
        }),
      })
    );
    expect(mocks.eventCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace-b",
          payload: { object: "instagram", entry: [entryB] },
        }),
      })
    );
    expect(mocks.eventUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["event-a", "event-b"] } },
      data: expect.objectContaining({ status: "PROCESSED" }),
    });
  });
});
