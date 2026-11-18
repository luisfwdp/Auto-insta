import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ enabled: true }));
const ledger = vi.hoisted(() => ({ find: vi.fn(), reserve: vi.fn(), begin: vi.fn(), finish: vi.fn(), receipt: vi.fn(), gate: vi.fn(), connection: vi.fn() }));
vi.mock("@/lib/billing/trial", () => ({ isBillingEnabled: () => state.enabled }));
vi.mock("@/lib/billing/commercial-usage", () => ({ findCommercialUsageOperation: ledger.find, reserveCommercialUsage: ledger.reserve, beginCommercialDispatch: ledger.begin,
  finishCommercialDispatch: ledger.finish, readCommercialUsageReceipt: ledger.receipt }));
vi.mock("@/lib/billing/commercial-capacity", () => ({ assertCommercialAccountUsable: ledger.gate }));
vi.mock("@/lib/db/client", () => ({ prisma: { zernioConnection: { findUnique: ledger.connection } } }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `decrypted:${value}` }));
import * as messaging from "../lib/instagram/send-messages";
import { createInstagramContext, type InstagramContext } from "../lib/instagram/context";
import { MetaApiError } from "../lib/meta/client";
import { DeliveryUnconfirmedError } from "../lib/instagram/delivery-errors";
import { BillingError } from "../lib/billing/config";

const reservationId = "10000000-0000-4000-8000-000000000001", token = "20000000-0000-4000-8000-000000000002";
const fetcher = vi.fn();
const context = (provider: "META" | "ZERNIO"): InstagramContext => provider === "META"
  ? { provider, workspaceId: "workspace_a", operationId: "job:stable", instagramId: "ig_a", accessToken: "fake-meta" }
  : { provider, workspaceId: "workspace_a", operationId: "job:stable", instagramId: "ig_a", apiKey: "fake-zernio", accountId: "z_account_a" };
const args = { instagramAccountId: "ig_a", userId: "recipient_secret", commentId: "comment_secret", postId: "post_a", message: "private message text", text: "private message text",
  buttonTitle: "Reveal", payload: "private_payload", buttons: [{ title: "Open", url: "https://example.test/private" }] };
const paths = [
  { kind: "private_plain", send: (ctx: InstagramContext) => messaging.sendPrivateReply({ context: ctx, ...args }) },
  { kind: "private_button", send: (ctx: InstagramContext) => messaging.sendPrivateReplyWithButton({ context: ctx, ...args }) },
  { kind: "private_link", send: (ctx: InstagramContext) => messaging.sendPrivateReplyWithLinkButton({ context: ctx, ...args }) },
  { kind: "direct_plain", send: (ctx: InstagramContext) => messaging.sendDirectMessage({ context: ctx, ...args }) },
  { kind: "direct_button", send: (ctx: InstagramContext) => messaging.sendDirectMessageWithButton({ context: ctx, ...args }) },
  { kind: "direct_link", send: (ctx: InstagramContext) => messaging.sendDirectMessageWithLinkButton({ context: ctx, ...args }) },
];
function respond(provider: "META" | "ZERNIO", body?: unknown, status = 200) {
  fetcher.mockResolvedValueOnce(Response.json(body ?? (provider === "META" ? { message_id: "m$real=+/_:1", recipient_id: args.userId } : { messageId: "z_real_message" }), { status }));
}
beforeEach(() => {
  state.enabled = true; vi.clearAllMocks(); fetcher.mockReset(); vi.stubGlobal("fetch", fetcher);
  ledger.find.mockReset().mockResolvedValue(null);
  ledger.reserve.mockResolvedValue({ mode: "commercial", reservationId, status: "RESERVED" });
  ledger.begin.mockResolvedValue({ dispatchToken: token }); ledger.finish.mockResolvedValue(true); ledger.receipt.mockResolvedValue(null); ledger.gate.mockResolvedValue(undefined);
});
afterAll(() => vi.unstubAllGlobals());

describe.each(["META", "ZERNIO"] as const)("commercial %s messaging", provider => {
  it.each(paths)("guards and charges exactly one DM for $kind, then saves only the real receipt", async ({ send }) => {
    respond(provider); const result = await send(context(provider));
    expect(fetcher).toHaveBeenCalledOnce(); expect(ledger.gate).toHaveBeenCalledWith("workspace_a", "ig_a");
    expect(ledger.reserve).toHaveBeenCalledWith("workspace_a", "DM", expect.stringMatching(/^message:[a-f0-9]{64}$/), 1);
    expect(ledger.begin).toHaveBeenCalledWith("workspace_a", reservationId);
    expect(ledger.finish).toHaveBeenCalledWith("workspace_a", reservationId, token, "CONFIRMED", {
      messageId: result.message_id, ...(result.recipient_id ? { recipientId: result.recipient_id } : {}) });
    const saved = JSON.stringify(ledger.reserve.mock.calls); expect(saved).not.toContain(args.message); expect(saved).not.toContain(args.userId); expect(saved).not.toContain(args.commentId);
  });
  it.each(paths)("preserves the legacy $kind send with no commercial DB/gate calls when disabled", async ({ send }) => {
    state.enabled = false; const ctx = context(provider); delete ctx.operationId; delete ctx.workspaceId;
    respond(provider); await send(ctx); expect(fetcher).toHaveBeenCalledOnce();
    for (const call of [ledger.find, ledger.reserve, ledger.begin, ledger.finish, ledger.gate, ledger.receipt]) expect(call).not.toHaveBeenCalled();
  });
  it("gates public replies without reserving or charging a DM", async () => {
    respond(provider, provider === "META" ? { id: "real_public_reply" } : { data: { commentId: "real_public_reply" } });
    expect(await messaging.sendCommentReply({ context: context(provider), ...args })).toEqual({ id: "real_public_reply" });
    expect(ledger.gate).toHaveBeenCalledWith("workspace_a", "ig_a"); expect(ledger.reserve).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
    state.enabled = false; ledger.gate.mockClear(); respond(provider, provider === "META" ? { id: "second" } : { data: { commentId: "second" } });
    await messaging.sendCommentReply({ context: context(provider), ...args }); expect(ledger.gate).not.toHaveBeenCalled();
  });
  it("fails all DM/public side effects when the account/access gate denies", async () => {
    ledger.gate.mockRejectedValue(new BillingError("COMMERCIAL_ACCOUNT_UNUSABLE", 402));
    for (const { send } of paths) await expect(send(context(provider))).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_UNUSABLE" });
    await expect(messaging.sendCommentReply({ context: context(provider), ...args })).rejects.toMatchObject({ code: "COMMERCIAL_ACCOUNT_UNUSABLE" });
    expect(fetcher).not.toHaveBeenCalled(); expect(ledger.begin).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
  });
});

it("propagates workspace and stable operations to both provider contexts", async () => {
  ledger.connection.mockResolvedValue({ apiKey: "encrypted-zernio" });
  for (const provider of ["META", "ZERNIO"] as const) {
    const result = await createInstagramContext({ provider, workspaceId: "workspace_a", operationId: "account:operation", instagramId: "ig_a", accessToken: "encrypted-meta", zernioAccountId: "z_account_a" }, "worker:operation");
    expect(result).toMatchObject({ workspaceId: "workspace_a", operationId: "worker:operation" });
  }
  expect(ledger.connection).toHaveBeenCalledWith({ where: { workspaceId: "workspace_a" }, select: { apiKey: true } });
});
it("requires stable operation/workspace/account binding before commercial dispatch", async () => {
  const missingOperation = context("META"); delete missingOperation.operationId;
  await expect(paths[3].send(missingOperation)).rejects.toMatchObject({ code: "COMMERCIAL_MESSAGE_OPERATION_REQUIRED" });
  const missingWorkspace = context("META"); delete missingWorkspace.workspaceId;
  await expect(paths[3].send(missingWorkspace)).rejects.toMatchObject({ code: "COMMERCIAL_MESSAGE_CONTEXT_REQUIRED" });
  await expect(messaging.sendDirectMessage({ context: context("META"), ...args, instagramAccountId: "ig_foreign" })).rejects.toMatchObject({ code: "COMMERCIAL_MESSAGE_ACCOUNT_MISMATCH" });
  expect(ledger.reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
it("uses stable hashes and separates operation, target, payload and each DM kind", async () => {
  const input = { context: context("META"), ...args };
  for (const value of [input, input, { ...input, userId: "another_recipient" }, { ...input, message: "changed" }, { ...input, context: { ...context("META"), operationId: "job:another" } }]) {
    respond("META"); await messaging.sendDirectMessage(value);
  }
  const keys = ledger.reserve.mock.calls.map(call => call[2]); expect(keys[0]).toBe(keys[1]); expect(new Set(keys).size).toBe(4);
  ledger.reserve.mockClear(); for (const { send } of paths) { respond("META"); await send(context("META")); }
  expect(new Set(ledger.reserve.mock.calls.map(call => call[2])).size).toBe(6);
});
it("replays COMMITTED using the real persisted receipt even if account access has since expired", async () => {
  ledger.find.mockResolvedValue({ reservationId, status: "COMMITTED" });
  ledger.receipt.mockResolvedValue({ messageId: "m$real=+/_:1", recipientId: args.userId });
  ledger.gate.mockRejectedValue(new BillingError("COMMERCIAL_ACCESS_REQUIRED", 402));
  expect(await paths[3].send(context("META"))).toEqual({ message_id: "m$real=+/_:1", recipient_id: args.userId });
  expect(ledger.receipt).toHaveBeenCalledWith("workspace_a", reservationId); expect(ledger.gate).not.toHaveBeenCalled(); expect(ledger.reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
it.each([null, { messageId: "" }, { messageId: 123 }, { messageId: "contains whitespace" }])("never fabricates an accepted result when stored receipt is unavailable %#", async receipt => {
  ledger.find.mockResolvedValue({ reservationId, status: "COMMITTED" }); ledger.receipt.mockResolvedValue(receipt);
  await expect(paths[3].send(context("META"))).rejects.toBeInstanceOf(DeliveryUnconfirmedError); expect(fetcher).not.toHaveBeenCalled();
});
it.each(["DISPATCHING", "RELEASED"])("does not resend a prior %s operation", async status => {
  ledger.find.mockResolvedValue({ reservationId, status });
  await expect(paths[3].send(context("META"))).rejects.toBeInstanceOf(DeliveryUnconfirmedError); expect(fetcher).not.toHaveBeenCalled(); expect(ledger.begin).not.toHaveBeenCalled();
  expect(ledger.gate).not.toHaveBeenCalled(); expect(ledger.reserve).not.toHaveBeenCalled();
});
it("does not send when another process won the dispatch CAS", async () => {
  ledger.begin.mockResolvedValue(null); await expect(paths[3].send(context("META"))).rejects.toBeInstanceOf(DeliveryUnconfirmedError); expect(fetcher).not.toHaveBeenCalled();
});
it("keeps a network failure unknown and holds the operation without automatic retry", async () => {
  fetcher.mockRejectedValueOnce(new Error("fake-sensitive-provider-detail"));
  await expect(paths[3].send(context("META"))).rejects.toBeInstanceOf(DeliveryUnconfirmedError);
  expect(ledger.finish).toHaveBeenCalledWith("workspace_a", reservationId, token, "UNKNOWN"); expect(fetcher).toHaveBeenCalledOnce();
  ledger.reserve.mockResolvedValue({ mode: "commercial", reservationId, status: "DISPATCHING" });
  await expect(paths[3].send(context("META"))).rejects.toThrow("needs reconciliation"); expect(fetcher).toHaveBeenCalledOnce();
});
it.each([{}, { message_id: "" }, { message_id: 123 }, { message_id: "wrong whitespace" }, { message_id: "mid", recipient_id: 123 }])("keeps malformed successful provider responses unknown %#", async result => {
  respond("META", result); await expect(paths[3].send(context("META"))).rejects.toBeInstanceOf(DeliveryUnconfirmedError);
  expect(ledger.finish).toHaveBeenCalledWith("workspace_a", reservationId, token, "UNKNOWN");
});
it.each(["write failure", "lost token"])("does not resend or release an accepted message after %s", async failure => {
  respond("META"); if (failure === "write failure") ledger.finish.mockRejectedValueOnce(new Error("database unavailable")); else ledger.finish.mockResolvedValueOnce(false);
  await expect(paths[3].send(context("META"))).rejects.toBeInstanceOf(DeliveryUnconfirmedError); expect(fetcher).toHaveBeenCalledOnce(); expect(ledger.finish).toHaveBeenCalledOnce();
  ledger.reserve.mockResolvedValue({ mode: "commercial", reservationId, status: "DISPATCHING" });
  await expect(paths[3].send(context("META"))).rejects.toBeInstanceOf(DeliveryUnconfirmedError); expect(fetcher).toHaveBeenCalledOnce();
});
it("permits a safe retry only after the ledger confirms a proven Meta rejection", async () => {
  respond("META", { error: { code: 100, message: "Invalid recipient" } }, 400);
  await expect(paths[3].send(context("META"))).rejects.toBeInstanceOf(MetaApiError);
  expect(ledger.finish).toHaveBeenCalledWith("workspace_a", reservationId, token, "DEFINITELY_REJECTED");
  respond("META"); await expect(paths[3].send(context("META"))).resolves.toHaveProperty("message_id"); expect(fetcher).toHaveBeenCalledTimes(2);
});

describe("manual request identity and immutable intent", () => {
  const requestId = "a0000000-0000-4000-8000-000000000001";
  const manualContext = (): InstagramContext => ({ ...context("META"), operationId: `manual:${requestId}` });

  function fingerprintLedger() {
    const operations = new Map<string, { fingerprint: string; committed: boolean }>();
    ledger.find.mockImplementation(async (workspaceId, resource, key, _amount, fingerprint) => {
      const previous = operations.get(`${workspaceId}:${resource}:${key}`);
      if (previous && previous.fingerprint !== fingerprint) throw new BillingError("USAGE_OPERATION_CONFLICT", 409);
      return previous ? { reservationId, status: previous.committed ? "COMMITTED" : "RESERVED" } : null;
    });
    ledger.reserve.mockImplementation(async (workspaceId, resource, key, _amount, fingerprint) => {
      if (!/^[a-f0-9]{64}$/.test(fingerprint ?? "")) throw new BillingError("INVALID_USAGE_FINGERPRINT", 400);
      const identity = `${workspaceId}:${resource}:${key}`, previous = operations.get(identity);
      if (previous && previous.fingerprint !== fingerprint) throw new BillingError("USAGE_OPERATION_CONFLICT", 409);
      if (!previous) operations.set(identity, { fingerprint, committed: false });
      return { mode: "commercial", reservationId, status: operations.get(identity)!.committed ? "COMMITTED" : "RESERVED" };
    });
    ledger.finish.mockImplementation(async (_workspace, _reservation, _token, outcome, receipt) => {
      if (outcome === "CONFIRMED") {
        for (const row of operations.values()) row.committed = true;
        ledger.receipt.mockResolvedValue(receipt);
      }
      return true;
    });
  }

  it("replays an identical UUID and intent from the receipt without a second provider call", async () => {
    fingerprintLedger(); respond("META");
    const input = { context: manualContext(), ...args };
    const first = await messaging.sendDirectMessage(input);
    expect(await messaging.sendDirectMessage(input)).toEqual(first);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(ledger.reserve.mock.calls[0]).toEqual(["workspace_a", "DM", expect.stringMatching(/^message:[a-f0-9]{64}$/), 1, expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(ledger.find.mock.calls[0]).toEqual(ledger.find.mock.calls[1]); expect(ledger.reserve).toHaveBeenCalledOnce();
  });

  it.each(["body", "target", "account", "kind"])("rejects a changed %s under the same manual UUID before another dispatch", async changed => {
    fingerprintLedger(); respond("META");
    await messaging.sendDirectMessage({ context: manualContext(), ...args });
    const changedInput = {
      context: changed === "account" ? { ...manualContext(), instagramId: "other_account" } : manualContext(),
      ...args,
      ...(changed === "body" ? { message: "changed private content" } : {}),
      ...(changed === "target" ? { userId: "other_recipient" } : {}),
      ...(changed === "account" ? { instagramAccountId: "other_account" } : {}),
    };
    const send = changed === "kind" ? messaging.sendDirectMessageWithButton : messaging.sendDirectMessage;
    await expect(send(changedInput)).rejects.toMatchObject({ code: "USAGE_OPERATION_CONFLICT", httpStatus: 409 });
    expect(fetcher).toHaveBeenCalledOnce(); expect(ledger.begin).toHaveBeenCalledOnce();
    const [first, second] = ledger.find.mock.calls;
    expect(first[2]).toBe(second[2]); expect(first[4]).not.toBe(second[4]);
    const saved = JSON.stringify([...ledger.find.mock.calls, ...ledger.reserve.mock.calls]);
    for (const secret of [args.message, args.userId, "changed private content", "other_recipient", "other_account"])
      expect(saved).not.toContain(secret);
  });

  it("uses a new identity for an explicitly new manual request UUID", async () => {
    fingerprintLedger(); respond("META"); respond("META");
    await messaging.sendDirectMessage({ context: manualContext(), ...args });
    await messaging.sendDirectMessage({ context: { ...manualContext(), operationId: "manual:b0000000-0000-4000-8000-000000000002" }, ...args });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ledger.reserve.mock.calls[0][2]).not.toBe(ledger.reserve.mock.calls[1][2]);
  });

  it("canonicalizes UUID case without changing identity or intent", async () => {
    fingerprintLedger(); respond("META");
    const first = await messaging.sendDirectMessage({ context: manualContext(), ...args });
    expect(await messaging.sendDirectMessage({ context: { ...manualContext(), operationId: `manual:${requestId.toUpperCase()}` }, ...args })).toEqual(first);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(ledger.find.mock.calls[0]).toEqual(ledger.find.mock.calls[1]); expect(ledger.reserve).toHaveBeenCalledOnce();
  });

  it.each(["manual:bad", "manual:", "manual:a0000000-0000-4000-8000-000000000001:extra"])("rejects malformed server manual identity %s before reservation", async operationId => {
    await expect(messaging.sendDirectMessage({ context: { ...manualContext(), operationId }, ...args })).rejects.toMatchObject({ code: "COMMERCIAL_MESSAGE_OPERATION_REQUIRED" });
    expect(ledger.reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the established nonmanual operation key and four-argument ledger contract", async () => {
    respond("META"); await paths[3].send(context("META"));
    expect(ledger.reserve.mock.calls[0]).toHaveLength(4);
    expect(ledger.reserve.mock.calls[0][2]).toBe("message:12fc263187f5e4017e540a5c228e015a0678509ecdc0ad978d00c83a02c317e1");
  });
});
it.each([408, 409])("does not classify Zernio HTTP%s as proof of rejection", async status => {
  respond("ZERNIO", {}, status); await expect(paths[3].send(context("ZERNIO"))).rejects.toBeInstanceOf(DeliveryUnconfirmedError);
  expect(ledger.finish).toHaveBeenCalledWith("workspace_a", reservationId, token, "UNKNOWN");
});
it("allows one concurrent dispatch winner and makes the loser uncertain without a second provider call", async () => {
  let claimed = false;
  ledger.begin.mockImplementation(async () => { if (claimed) return null; claimed = true; return { dispatchToken: token }; });
  respond("META"); const results = await Promise.allSettled([paths[3].send(context("META")), paths[3].send(context("META"))]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toMatchObject([{ reason: { name: "DeliveryUnconfirmedError" } }]);
  expect(fetcher).toHaveBeenCalledOnce();
});
it("returns the actual receipt on a retry after a successful commit without another send", async () => {
  let committed = false;
  ledger.reserve.mockImplementation(async () => ({ mode: "commercial", reservationId, status: committed ? "COMMITTED" : "RESERVED" }));
  ledger.finish.mockImplementation(async (_workspace, _reservation, _token, outcome, receipt) => {
    if (outcome === "CONFIRMED") { committed = true; ledger.receipt.mockResolvedValue(receipt); } return true;
  });
  respond("META"); const first = await paths[3].send(context("META"));
  expect(await paths[3].send(context("META"))).toEqual(first); expect(fetcher).toHaveBeenCalledOnce();
});
