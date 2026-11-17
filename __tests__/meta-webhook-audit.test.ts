import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  queryRaw: vi.fn(),
  createEvent: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: {
  instagramAccount: { findMany: mocks.findMany },
  operationalEvent: { create: mocks.createEvent },
  $queryRaw: mocks.queryRaw,
} }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "anonymous-token" }));

import { auditMetaWebhookSubscriptions } from "@/lib/ops/meta-webhook-audit";
import { getInstagramAccountWebhookFields } from "@/lib/meta/client";

const fetchMock = vi.fn();
const account = {
  id: "acc_1", workspaceId: "ws_1", instagramId: "ig_test", username: "anon",
  accessToken: "encrypted", provider: "META", zernioAccountId: null,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("META_GRAPH_API_VERSION", "v26.0");
  vi.stubEnv("INSTAGRAM_LOGIN_MODE", "unified");
  mocks.findMany.mockResolvedValue([account]);
  mocks.queryRaw.mockResolvedValue([{ comments: BigInt(12), messaging: BigInt(0) }]);
  mocks.createEvent.mockResolvedValue({});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Meta webhook subscription audit", () => {
  it("reads the IG User subscription without putting the token in the URL", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ subscribed_fields: ["messages", "comments"] }] }));
    await expect(getInstagramAccountWebhookFields("ig_test", "anonymous-token")).resolves.toEqual(["comments", "messages"]);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v26.0/ig_test/subscribed_apps");
    expect(options.method).toBeUndefined();
    expect(options.headers.Authorization).toBe("Bearer anonymous-token");
  });

  it("flags an account whose effective subscription lacks messages", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ subscribed_fields: ["comments"] }] }))
      .mockResolvedValueOnce(json({ data: [
        { permission: "instagram_manage_messages", status: "granted" },
        { permission: "instagram_manage_comments", status: "granted" },
        { permission: "instagram_content_publish", status: "declined" },
      ] }));

    await expect(auditMetaWebhookSubscriptions()).resolves.toBe(1);

    const { data } = mocks.createEvent.mock.calls[0][0];
    expect(data).toMatchObject({ workspaceId: "ws_1", source: "HEALTH", level: "WARNING" });
    expect(data.payload).toMatchObject({
      instagramAccountId: "acc_1",
      loginMode: "unified",
      subscribedFields: ["comments"],
      missingFields: ["messages"],
      subscriptionError: null,
      grantedPermissions: ["instagram_manage_comments", "instagram_manage_messages"],
      receivedLast7Days: { comments: 12, messaging: 0 },
    });
    expect(JSON.stringify(data)).not.toContain("anonymous-token");
    expect(JSON.stringify(data)).not.toContain("encrypted");
  });

  it("records INFO when comments and messages are both subscribed", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ subscribed_fields: ["comments", "messages"] }] }))
      .mockResolvedValueOnce(json({ data: [] }));
    await auditMetaWebhookSubscriptions();
    const { data } = mocks.createEvent.mock.calls[0][0];
    expect(data.level).toBe("INFO");
    expect(data.payload.missingFields).toEqual([]);
    expect(data.payload.grantedPermissions).toBeNull();
  });

  it("records the Meta rejection instead of guessing the subscription", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: { code: 100, message: "Anonymous read rejection" } }, 400))
      .mockResolvedValueOnce(json({ data: [] }));
    await auditMetaWebhookSubscriptions();
    const { data } = mocks.createEvent.mock.calls[0][0];
    expect(data.level).toBe("WARNING");
    expect(data.payload.subscribedFields).toBeNull();
    expect(data.payload.missingFields).toBeNull();
    expect(data.payload.subscriptionError).toContain("Anonymous read rejection");
  });

  it("makes no write request to Meta", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ subscribed_fields: ["comments"] }] }))
      .mockResolvedValueOnce(json({ data: [] }));
    await auditMetaWebhookSubscriptions();
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.method ?? "GET").toBe("GET");
    }
  });
});
