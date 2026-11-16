import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ accounts: vi.fn(), eventCreate: vi.fn(), eventUpdate: vi.fn(), operationalCreate: vi.fn(), queueAdd: vi.fn(), transaction: vi.fn(), executeRaw: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: {
  instagramAccount: { findMany: mocks.accounts },
  webhookEvent: { create: mocks.eventCreate, updateMany: mocks.eventUpdate },
  operationalEvent: { create: mocks.operationalCreate },
  $transaction: mocks.transaction,
} }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mocks.queueAdd }), MESSAGE_JOB_NAME: "process-message", POSTBACK_JOB_NAME: "process-postback",
}));

const unknown = {
  id: "unconnected-account", time: 1,
  changes: [{ field: "private-field-name", value: { text: "private-comment" } }],
  messaging: [{ sender: { id: "private-sender" }, recipient: { id: "private-recipient" }, message: { mid: "private-mid", text: "private-message" } }],
};
let processWebhook: typeof import("@/lib/queue/process-webhook").processInstagramWebhook;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T10:00:00Z"));
  mocks.accounts.mockResolvedValue([]);
  mocks.operationalCreate.mockResolvedValue({});
  mocks.eventCreate.mockResolvedValue({ id: "event" });
  mocks.eventUpdate.mockResolvedValue({ count: 1 });
  mocks.executeRaw.mockResolvedValue(0);
  mocks.transaction.mockImplementation(async (operation) => operation({
    $executeRaw: mocks.executeRaw, operationalEvent: { create: mocks.operationalCreate },
  }));
  processWebhook = (await import("@/lib/queue/process-webhook")).processInstagramWebhook;
});
afterEach(() => vi.useRealTimers());

describe("signed unmatched Instagram webhook diagnostics", () => {
  it("records only bounded hashes and type counts when the account filter drops all entries", async () => {
    await processWebhook({ provider: "META", payload: { object: "instagram", entry: [unknown] } });
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    const { data } = mocks.operationalCreate.mock.calls[0][0];
    expect(data.workspaceId).toBeNull();
    expect(data.payload).toEqual({
      provider: "META", receivedEntries: 1, matchedEntries: 0, unmatchedEntries: 1,
      entryIdHashes: [createHash("sha256").update(unknown.id).digest("hex")],
      eventCounts: { comments: 0, liveComments: 0, messages: 1, postbacks: 0, reads: 0, reactions: 0, otherChanges: 1, otherMessaging: 0 },
    });
    for (const raw of [unknown.id, "private-field-name", "private-comment", "private-sender", "private-recipient", "private-mid", "private-message"])
      expect(JSON.stringify(data)).not.toContain(raw);
  });

  it("persists and queues only matching entries while diagnosing the unmatched subset", async () => {
    mocks.accounts.mockResolvedValue([{ id: "connection", instagramId: "connected", workspaceId: "workspace" }]);
    const matched = { ...unknown, id: "connected" };
    await processWebhook({ provider: "META", payload: { object: "instagram", entry: [unknown, matched] } });
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      workspaceId: "workspace", payload: { object: "instagram", entry: [matched] },
    }) }));
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
    expect(mocks.queueAdd.mock.calls[0][1]).toEqual(expect.objectContaining({ instagramAccountId: "connected", accountConnectionId: "connection" }));
    expect(mocks.operationalCreate.mock.calls[0][0].data.payload).toEqual(expect.objectContaining({ receivedEntries: 2, matchedEntries: 1, unmatchedEntries: 1 }));
  });

  it("dispatches known-account delivery before awaiting a slow diagnostic transaction", async () => {
    mocks.accounts.mockResolvedValue([{ id: "connection", instagramId: "connected", workspaceId: "workspace" }]);
    let release!: () => void;
    mocks.operationalCreate.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = processWebhook({ provider: "META", payload: { object: "instagram", entry: [unknown, { ...unknown, id: "connected" }] } });
    try {
      await vi.waitFor(() => expect(mocks.operationalCreate).toHaveBeenCalledOnce());
      expect(mocks.queueAdd).toHaveBeenCalledOnce();
      expect(mocks.eventUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PROCESSED" }) }));
      expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 250, timeout: 1500 });
      expect(mocks.executeRaw.mock.calls.map(([query]) => query.join(""))).toEqual([
        "SET LOCAL statement_timeout = '1000ms'", "SET LOCAL lock_timeout = '250ms'",
      ]);
    } finally {
      release();
      await pending;
    }
  });

  it("bounds concurrent diagnostics to one per provider per minute with at most five hashes", async () => {
    const payload = { object: "instagram", entry: Array.from({ length: 20 }, (_, index) => ({ ...unknown, id: `unknown-${index}` })) };
    await Promise.all(Array.from({ length: 50 }, () => processWebhook({ provider: "META", payload })));
    expect(mocks.operationalCreate).toHaveBeenCalledOnce();
    expect(mocks.operationalCreate.mock.calls[0][0].data.payload.entryIdHashes).toHaveLength(5);
    await processWebhook({ provider: "ZERNIO", workspaceId: "private-workspace", payload });
    expect(mocks.operationalCreate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.operationalCreate.mock.calls)).not.toContain("private-workspace");
    vi.advanceTimersByTime(60_000);
    await processWebhook({ provider: "META", payload });
    expect(mocks.operationalCreate).toHaveBeenCalledTimes(3);
  });

  it("does not block matching delivery or retry logging repeatedly when diagnostic persistence fails", async () => {
    mocks.operationalCreate.mockRejectedValue(new Error("private database details"));
    mocks.accounts.mockResolvedValue([{ id: "connection", instagramId: "connected", workspaceId: "workspace" }]);
    const payload = { object: "instagram", entry: [unknown, { ...unknown, id: "connected" }] };
    await processWebhook({ provider: "META", payload });
    await processWebhook({ provider: "META", payload });
    expect(mocks.operationalCreate).toHaveBeenCalledOnce();
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
  });

  it.each([
    { changes: { malformed: true } },
    { changes: [null] },
    { messaging: { malformed: true } },
    { messaging: [null] },
  ])("delivers a matched message despite malformed unmatched diagnostic fields: %j", async (malformedFields) => {
    mocks.accounts.mockResolvedValue([{ id: "connection", instagramId: "connected", workspaceId: "workspace" }]);
    const matched = { ...unknown, id: "connected" };
    // Signature verification authenticates the sender, not the runtime shape.
    const malformed = { ...unknown, ...malformedFields } as unknown as typeof unknown;
    const payload = { object: "instagram", entry: [malformed, matched] };
    await expect(processWebhook({ provider: "META", payload })).resolves.toBeUndefined();
    expect(mocks.operationalCreate).not.toHaveBeenCalled();
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      workspaceId: "workspace", payload: { object: "instagram", entry: [matched] },
    }) }));
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
    expect(mocks.queueAdd.mock.calls[0][1]).toEqual(expect.objectContaining({
      instagramAccountId: "connected", accountConnectionId: "connection", messageText: "private-message",
    }));
    expect(mocks.eventUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PROCESSED" }) }));
  });

  it("emits no unmatched diagnostic for fully matching or non-Instagram payloads", async () => {
    mocks.accounts.mockResolvedValue([{ id: "connection", instagramId: unknown.id, workspaceId: "workspace" }]);
    await processWebhook({ provider: "META", payload: { object: "instagram", entry: [unknown] } });
    await processWebhook({ provider: "META", payload: { object: "page", entry: [unknown] } });
    expect(mocks.operationalCreate).not.toHaveBeenCalled();
  });
});
