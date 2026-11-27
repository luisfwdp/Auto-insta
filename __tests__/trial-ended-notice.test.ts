import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ billingFindMany: vi.fn(), eventFindFirst: vi.fn(), eventCreate: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: {
  workspaceBilling: { findMany: mocks.billingFindMany },
  operationalEvent: { findFirst: mocks.eventFindFirst, create: mocks.eventCreate },
} }));

import { sendTrialEndedNotices, trialEndedMessage, TRIAL_ENDED_LOOKBACK_MS, TRIAL_ENDED_NOTICE_MESSAGE } from "@/lib/email/trial-ended";
import { MIN_RETENTION_DAYS } from "@/lib/privacy/retention";

const fetchMock = vi.fn();
const now = new Date("2026-11-23T12:00:00.000Z");
const row = (workspaceId: string, email: string | null, lifetimeAccess: unknown = null) => ({
  workspaceId, status: "TRIALING", lifetimeAccess, workspace: { id: workspaceId, ownerId: "owner_1", owner: { email } },
});
const grant = (workspaceId: string, extra: Record<string, unknown> = {}) => ({
  id: "7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d", workspaceId, ownerId: "owner_1", planId: "agency-v1",
  grantedAt: new Date("2026-11-22T00:00:00.000Z"), grantedBy: "operator", reason: "approved", approvalReference: "ref-1",
  revokedAt: null, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("RESEND_API_KEY", "anonymous-key");
  vi.stubEnv("EMAIL_FROM", "PING CHAT <contato@example.test>");
  vi.stubEnv("EMAIL_REPLY_TO", "contato@example.test");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.test/");
  mocks.billingFindMany.mockResolvedValue([row("ws_1", "owner@example.test")]);
  mocks.eventFindFirst.mockResolvedValue(null);
  mocks.eventCreate.mockResolvedValue({});
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: "email_1" })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("trial ended notice", () => {
  it("does nothing when billing, email or the app URL is not configured", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");
    expect(await sendTrialEndedNotices(now)).toBeNull();
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await sendTrialEndedNotices(now)).toBeNull();
    vi.stubEnv("RESEND_API_KEY", "anonymous-key");
    vi.stubEnv("NEXTAUTH_URL", "");
    expect(await sendTrialEndedNotices(now)).toBeNull();
    expect(mocks.billingFindMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects only unpaid trials that ended inside the lookback window", async () => {
    await sendTrialEndedNotices(now);
    const where = mocks.billingFindMany.mock.calls[0][0].where;
    expect(where).toEqual({
      status: "TRIALING",
      trialEndsAt: { lte: now, gt: new Date(now.getTime() - TRIAL_ENDED_LOOKBACK_MS) },
      paidThrough: null,
    });
  });

  it("emails the owner once and records a marker without the address", async () => {
    expect(await sendTrialEndedNotices(now)).toEqual({ candidates: 1, sent: 1, failed: 0 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ to: "owner@example.test", subject: "Seu teste grátis do PING CHAT terminou", reply_to: "contato@example.test" });
    expect(body.text).toContain("https://app.example.test/billing");
    expect(mocks.eventCreate).toHaveBeenCalledWith({
      data: { workspaceId: "ws_1", source: "SYSTEM", level: "INFO", message: TRIAL_ENDED_NOTICE_MESSAGE },
    });
    expect(JSON.stringify(mocks.eventCreate.mock.calls)).not.toContain("owner@example.test");
  });

  it("does not email a workspace that already has the marker", async () => {
    mocks.eventFindFirst.mockResolvedValue({ id: "event_1" });
    expect(await sendTrialEndedNotices(now)).toEqual({ candidates: 1, sent: 0, failed: 0 });
    expect(mocks.eventFindFirst.mock.calls[0][0].where).toEqual({ workspaceId: "ws_1", message: TRIAL_ENDED_NOTICE_MESSAGE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves no marker when the provider rejects the send, so it is retried", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ message: "rejected" }), { status: 422 }));
    expect(await sendTrialEndedNotices(now)).toEqual({ candidates: 1, sent: 0, failed: 1 });
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it("skips owners without an email and keeps going", async () => {
    mocks.billingFindMany.mockResolvedValue([row("ws_1", null), row("ws_2", "b@example.test")]);
    expect(await sendTrialEndedNotices(now)).toEqual({ candidates: 2, sent: 1, failed: 0 });
    expect(mocks.eventCreate.mock.calls[0][0].data.workspaceId).toBe("ws_2");
  });

  it("does not tell a licensed workspace that its campaigns stopped", async () => {
    mocks.billingFindMany.mockResolvedValue([row("ws_1", "owner@example.test", grant("ws_1"))]);
    expect(await sendTrialEndedNotices(now)).toEqual({ candidates: 1, sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it("still notifies when the license is revoked or belongs to another owner", async () => {
    mocks.billingFindMany.mockResolvedValue([
      row("ws_1", "a@example.test", grant("ws_1", { revokedAt: new Date("2026-11-22T12:00:00.000Z") })),
      row("ws_2", "b@example.test", grant("ws_2", { ownerId: "owner_other" })),
    ]);
    expect(await sendTrialEndedNotices(now)).toEqual({ candidates: 2, sent: 2, failed: 0 });
  });

  it("keeps the lookback shorter than the minimum retention of its marker", () => {
    expect(TRIAL_ENDED_LOOKBACK_MS).toBeLessThan(MIN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  });

  it("writes a plain message with the billing link and the contact", () => {
    const message = trialEndedMessage("a@example.test", "https://app.example.test", null);
    expect(message.text).toContain("as suas campanhas param de enviar");
    expect(message.text).toContain("responda a este e-mail.");
    expect(message.html).toContain("<p>");
  });
});
