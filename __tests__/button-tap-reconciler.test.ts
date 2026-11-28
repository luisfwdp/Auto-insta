import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  automationFindMany: vi.fn(), dmLogFindFirst: vi.fn(), eventCreate: vi.fn(),
  queueAdd: vi.fn(), redisEval: vi.fn(), redisExists: vi.fn(), redisSet: vi.fn(), getConversations: vi.fn(), createContext: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: {
  automation: { findMany: mocks.automationFindMany },
  dmLog: { findFirst: mocks.dmLogFindFirst },
  operationalEvent: { create: mocks.eventCreate },
} }));
vi.mock("@/lib/queue/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/queue/client")>(),
  POSTBACK_JOB_NAME: "process-postback",
  getDMQueue: () => ({ add: mocks.queueAdd }),
  getRedisConnection: () => ({ eval: mocks.redisEval, exists: mocks.redisExists, set: mocks.redisSet }),
}));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/meta/client")>(),
  async *iterateConversations(...args: unknown[]) {
    yield* await mocks.getConversations(...args);
  },
}));
vi.mock("@/lib/instagram/context", () => ({
  createInstagramContext: mocks.createContext,
  hasInstagramCredentials: (account: { accessToken: string }) => Boolean(account.accessToken),
}));

import { reconcileButtonTaps, BUTTON_TAP_LOOKBACK_MS, BUTTON_TAP_RECOVERED_MESSAGE } from "@/lib/polling/button-tap-reconciler";
import { MetaApiError } from "@/lib/meta/client";

const now = new Date("2026-11-25T03:00:00.000Z");
const account = { id: "acct_1", instagramId: "ig_account", accessToken: "encrypted", provider: "META", workspaceId: "ws_1", zernioAccountId: null };
const automation = (extra: Record<string, unknown> = {}) => ({
  id: "auto_1", workspaceId: "ws_1", requireFollow: true, followPromptButtonLabel: "Já estou seguindo",
  openingDmEnabled: false, openingDmMessage: null, openingDmButtonLabel: null, instagramAccount: account, ...extra,
});
// Anonymized shape of GET /{ig-user-id}/conversations?fields=participants,updated_time,messages.limit(1){message,from,created_time}
const conversation = (extra: Record<string, unknown> = {}) => ({
  id: "conv_1", updated_time: "2026-11-25T02:58:00+0000",
  participants: { data: [{ id: "user_1", username: "anon_user" }, { id: "ig_account", username: "anon_account" }] },
  messages: { data: [{ id: "mid_1", message: "Já estou seguindo", from: { id: "user_1", username: "anon_user" }, created_time: "2026-11-25T02:58:00+0000", ...extra }] },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.automationFindMany.mockResolvedValue([automation()]);
  // First call: "any recent prompt?"; later calls: "who prompted this person?"
  mocks.dmLogFindFirst.mockImplementation(async (args: { where: { commenterId?: string } }) =>
    args.where.commenterId ? { automationId: "auto_1" } : { id: "log_1" });
  mocks.createContext.mockResolvedValue({ provider: "META", accessToken: "token", instagramId: "ig_account" });
  mocks.getConversations.mockResolvedValue([conversation()]);
  mocks.redisEval.mockResolvedValue(1);
  mocks.redisExists.mockResolvedValue(0);
  mocks.redisSet.mockResolvedValue("OK");
  mocks.queueAdd.mockResolvedValue({});
  mocks.eventCreate.mockResolvedValue({});
});

describe("button tap recovery from conversations", () => {
  const direct = automation({
    dmTriggerEnabled: true, postId: null, matchAnyPost: false, pendingNextReel: false,
    matchAnyWord: false, wholeWordMatch: true, keywords: ["mercado"],
    updatedAt: new Date("2026-11-25T02:55:00Z"),
  });

  it("recovers an incoming keyword DM before any campaign prompt and uses the webhook job ID", async () => {
    mocks.automationFindMany.mockResolvedValue([direct]);
    mocks.dmLogFindFirst.mockResolvedValue(null);
    mocks.getConversations.mockResolvedValue([conversation({ id: "mid:1", message: "Mercado" })]);
    expect(await reconcileButtonTaps(now, "recent")).toEqual({ accounts: 1, recovered: 1, errors: 0 });
    expect(mocks.queueAdd).toHaveBeenCalledWith("process-message", expect.objectContaining({
      accountConnectionId: "acct_1", messageId: "mid:1", messageText: "Mercado",
      messageSentAt: Date.parse("2026-11-25T02:58:00Z"), recoveredFromConversation: true,
    }), { jobId: "message_ig_account_bWlkOjE" });
  });

  it.each([
    { message: "mercado", story: { id: "story-1" } },
    { message: "mercado", is_unsupported: true },
    { message: "mercado", created_time: "2026-11-25T02:54:00Z" },
    { message: "obrigado" },
  ])("does not recover an out-of-scope or pre-activation message (%j)", async (message) => {
    mocks.automationFindMany.mockResolvedValue([direct]);
    mocks.dmLogFindFirst.mockResolvedValue(null);
    mocks.getConversations.mockResolvedValue([conversation(message)]);
    expect(await reconcileButtonTaps(now, "recent")).toEqual({ accounts: 1, recovered: 0, errors: 0 });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("enqueues the follow check the missing postback webhook would have enqueued", async () => {
    expect(await reconcileButtonTaps(now)).toEqual({ accounts: 1, recovered: 1, errors: 0 });
    expect(mocks.queueAdd).toHaveBeenCalledWith("process-postback",
      { instagramAccountId: "ig_account", accountConnectionId: "acct_1", userId: "user_1", payload: "followcheck:auto_1", mid: "mid_1",
        tapTimeSeconds: new Date("2026-11-25T02:58:00.000Z").getTime() / 1000 },
      { jobId: "postback_ig_account_user_1_mid_1" });
    expect(mocks.redisSet).toHaveBeenCalledWith("button_tap_seen:ig_account:mid_1", expect.any(String), "EX", 60, "NX");
    const claim = mocks.redisSet.mock.calls[0][1];
    expect(mocks.redisEval).toHaveBeenCalledWith(expect.any(String), 1, "button_tap_seen:ig_account:mid_1", claim, 172800);
  });

  it("only looks at active META campaigns with buttons or a DM-only trigger", async () => {
    await reconcileButtonTaps(now);
    expect(mocks.automationFindMany.mock.calls[0][0].where).toEqual({
      isActive: true, OR: [
        { requireFollow: true }, { openingDmEnabled: true },
        { dmTriggerEnabled: true, postId: null, matchAnyPost: false, pendingNextReel: false },
      ], instagramAccount: { provider: "META" },
    });
  });

  it("makes no Graph API call when the account prompted nobody recently", async () => {
    mocks.dmLogFindFirst.mockResolvedValue(null);
    expect(await reconcileButtonTaps(now)).toEqual({ accounts: 0, recovered: 0, errors: 0 });
    expect(mocks.getConversations).not.toHaveBeenCalled();
    expect(mocks.dmLogFindFirst.mock.calls[0][0].where).toMatchObject({
      workspaceId: "ws_1", instagramAccountId: "acct_1", status: "SENT",
      dmSentAt: { gte: new Date(now.getTime() - BUTTON_TAP_LOOKBACK_MS) },
    });
  });

  it("uses only the first Graph page for accounts with a DM in the past ten minutes", async () => {
    expect(await reconcileButtonTaps(now, "recent")).toEqual({ accounts: 1, recovered: 1, errors: 0 });
    expect(mocks.dmLogFindFirst.mock.calls[0][0].where.dmSentAt.gte).toEqual(new Date(now.getTime() - 600_000));
    expect(mocks.getConversations).toHaveBeenCalledWith(
      "token", account.instagramId, expect.objectContaining({ firstPageOnly: true, signal: expect.any(AbortSignal) }),
    );
    expect(mocks.dmLogFindFirst.mock.calls[1][0].where.dmSentAt.gte).toEqual(new Date(now.getTime() - BUTTON_TAP_LOOKBACK_MS));
  });

  it("keeps a recent follow prompt eligible after the opening DM ages out of the fast window", async () => {
    mocks.dmLogFindFirst.mockResolvedValueOnce(null);
    mocks.redisExists.mockResolvedValueOnce(1);

    expect(await reconcileButtonTaps(now, "recent")).toEqual({ accounts: 1, recovered: 1, errors: 0 });
    expect(mocks.redisExists).toHaveBeenNthCalledWith(1, "button_tap_recent_prompt:acct_1");
    expect(mocks.getConversations).toHaveBeenCalledOnce();
  });

  it("skips fast scans for accounts without a recent opening or follow prompt", async () => {
    mocks.dmLogFindFirst.mockResolvedValueOnce(null);
    await expect(reconcileButtonTaps(now, "recent")).resolves.toEqual({ accounts: 0, recovered: 0, errors: 0 });
    expect(mocks.getConversations).not.toHaveBeenCalled();
  });

  it("backs off Graph reads for an account that reaches Meta's Instagram rate limit", async () => {
    mocks.getConversations.mockRejectedValueOnce(new MetaApiError(80002, undefined, undefined, "rate limit"));
    expect(await reconcileButtonTaps(now, "recent")).toEqual({ accounts: 1, recovered: 0, errors: 1 });
    expect(mocks.redisSet).toHaveBeenCalledWith("button_tap_scan_rate_limit:acct_1", "1", "EX", 300);

    mocks.getConversations.mockClear();
    mocks.redisExists.mockResolvedValueOnce(1);
    await expect(reconcileButtonTaps(now, "full")).resolves.toEqual({ accounts: 0, recovered: 0, errors: 0 });
    expect(mocks.getConversations).not.toHaveBeenCalled();
  });

  it.each([
    ["a message sent by the account itself", { from: { id: "ig_account" } }],
    ["any other text", { message: "oi, tudo bem?" }],
    ["a tap older than the messaging window", { created_time: "2026-11-23T02:58:00+0000" }],
    ["a message without an id", { id: undefined }],
    ["a message dated in the future", { created_time: "2026-11-25T04:00:00+0000" }],
  ])("ignores %s", async (_label, extra) => {
    mocks.getConversations.mockResolvedValue([conversation(extra)]);
    expect((await reconcileButtonTaps(now)).recovered).toBe(0);
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("matches the button title regardless of case and surrounding spaces", async () => {
    mocks.getConversations.mockResolvedValue([conversation({ message: "  JÁ ESTOU SEGUINDO " })]);
    expect((await reconcileButtonTaps(now)).recovered).toBe(1);
  });

  it("does nothing for a person these campaigns never contacted before the tap", async () => {
    mocks.dmLogFindFirst.mockImplementation(async (args: { where: { commenterId?: string } }) =>
      args.where.commenterId ? null : { id: "log_1" });
    expect((await reconcileButtonTaps(now)).recovered).toBe(0);
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    const where = mocks.dmLogFindFirst.mock.calls[1][0].where;
    expect(where).toMatchObject({
      workspaceId: "ws_1", instagramAccountId: "acct_1", status: "SENT", commenterId: "user_1",
      dmSentAt: { lte: new Date("2026-11-25T02:58:00.000Z") },
    });
  });

  it("handles each tap once across polls", async () => {
    mocks.redisSet.mockResolvedValue(null);
    expect((await reconcileButtonTaps(now)).recovered).toBe(0);
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it("retries the same tap on the next sweep after enqueue fails", async () => {
    mocks.queueAdd.mockRejectedValueOnce(new Error("queue offline"));
    expect(await reconcileButtonTaps(now)).toEqual({ accounts: 1, recovered: 0, errors: 1 });
    expect(mocks.redisEval).toHaveBeenCalledWith(
      expect.any(String), 1, "button_tap_seen:ig_account:mid_1", mocks.redisSet.mock.calls[0][1], 0,
    );

    expect(await reconcileButtonTaps(now)).toEqual({ accounts: 1, recovered: 1, errors: 0 });
    expect(mocks.queueAdd.mock.calls[0][2]).toEqual(mocks.queueAdd.mock.calls[1][2]);
    expect(mocks.redisSet).toHaveBeenCalledTimes(2);
  });

  it("enqueues the first verified tap even when a later conversation page fails", async () => {
    async function* interruptedScan() {
      yield conversation();
      throw new DOMException("Graph preview timed out", "TimeoutError");
    }
    mocks.getConversations.mockResolvedValue(interruptedScan());

    expect(await reconcileButtonTaps(now)).toEqual({ accounts: 1, recovered: 1, errors: 1 });
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
    expect(mocks.eventCreate).toHaveBeenCalledOnce();
  });

  it("holds a short claim when marking the enqueued job fails and retries with the same job id", async () => {
    mocks.redisEval.mockRejectedValueOnce(new Error("marker unavailable"));
    mocks.redisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null).mockResolvedValueOnce("OK");
    expect((await reconcileButtonTaps(now)).errors).toBe(1);
    expect((await reconcileButtonTaps(now)).recovered).toBe(0);
    expect((await reconcileButtonTaps(now)).recovered).toBe(1);
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
    expect(mocks.queueAdd.mock.calls[0][2]).toEqual(mocks.queueAdd.mock.calls[1][2]);
  });

  it("enqueues only once during overlapping sweeps while the first claim is pending", async () => {
    mocks.redisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    const sweeps = await Promise.all([reconcileButtonTaps(now), reconcileButtonTaps(now)]);
    expect(sweeps.map(({ recovered }) => recovered).sort()).toEqual([0, 1]);
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it("ignores campaigns linked to an account from another workspace", async () => {
    mocks.automationFindMany.mockResolvedValue([automation({ workspaceId: "foreign" })]);
    expect(await reconcileButtonTaps(now)).toEqual({ accounts: 0, recovered: 0, errors: 0 });
    expect(mocks.dmLogFindFirst).not.toHaveBeenCalled();
  });

  it("uses the campaign that contacted the person when two share the same button title", async () => {
    mocks.automationFindMany.mockResolvedValue([automation(), automation({ id: "auto_2" })]);
    mocks.dmLogFindFirst.mockImplementation(async (args: { where: { commenterId?: string } }) =>
      args.where.commenterId ? { automationId: "auto_2" } : { id: "log_1" });
    await reconcileButtonTaps(now);
    expect(mocks.queueAdd.mock.calls[0][1].payload).toBe("followcheck:auto_2");
  });

  it.each([
    [true, "followcheck:auto_1:open"],
    [false, "reveal:auto_1:open"],
  ])("recovers an opening-DM tap (requireFollow %s)", async (requireFollow, payload) => {
    mocks.automationFindMany.mockResolvedValue([automation({
      requireFollow, openingDmEnabled: true, openingDmMessage: "Quer o link?", openingDmButtonLabel: "Quero o link",
    })]);
    mocks.getConversations.mockResolvedValue([conversation({ message: "Quero o link" })]);
    await reconcileButtonTaps(now);
    expect(mocks.queueAdd.mock.calls[0][1].payload).toBe(payload);
  });

  it("records a count-only event and never the recipient or the text", async () => {
    await reconcileButtonTaps(now);
    expect(mocks.eventCreate).toHaveBeenCalledWith({ data: {
      workspaceId: "ws_1", source: "SYSTEM", level: "INFO", message: BUTTON_TAP_RECOVERED_MESSAGE, payload: { recovered: 1 },
    } });
    const logged = JSON.stringify(mocks.eventCreate.mock.calls);
    expect(logged).not.toContain("user_1");
    expect(logged).not.toContain("seguindo");
  });

  it("counts a failing account and keeps going with the next one", async () => {
    const second = { ...account, id: "acct_2", instagramId: "ig_account_2" };
    mocks.automationFindMany.mockResolvedValue([automation(), automation({ id: "auto_2", instagramAccount: second })]);
    mocks.dmLogFindFirst.mockImplementation(async (args: { where: { commenterId?: string } }) =>
      args.where.commenterId ? { automationId: "auto_2" } : { id: "log_1" });
    mocks.getConversations.mockRejectedValueOnce(new Error("Meta 190")).mockResolvedValueOnce([conversation()]);
    expect(await reconcileButtonTaps(now)).toEqual({ accounts: 2, recovered: 1, errors: 1 });
  });

  it("skips an account without credentials", async () => {
    mocks.automationFindMany.mockResolvedValue([automation({ instagramAccount: { ...account, accessToken: "" } })]);
    expect(await reconcileButtonTaps(now)).toEqual({ accounts: 0, recovered: 0, errors: 0 });
    expect(mocks.dmLogFindFirst).not.toHaveBeenCalled();
  });
});
