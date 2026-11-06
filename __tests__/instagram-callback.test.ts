/**
 * The Instagram OAuth callback: which requests are turned away before any
 * Meta call, why, and that nothing secret ends up in logs or redirects; plus
 * the happy path for Facebook Login for Business (Unified Login).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  workspaceMember: { findFirst: vi.fn() },
  instagramAccount: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  operationalEvent: { create: vi.fn() },
}));
const meta = vi.hoisted(() => ({
  resolveAssignedInstagramAccounts: vi.fn(),
  getUserInfo: vi.fn(),
  getLongLivedToken: vi.fn(),
  subscribeInstagramAccountToWebhooks: vi.fn(),
}));
const authMock = vi.hoisted(() => vi.fn());

// In-memory stand-in for Redis GETDEL: the first consumer gets the owner back,
// every later one gets null.
const nonces = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/meta/oauth-nonce", () => ({
  rememberOAuthNonce: vi.fn(async (nonce: string, userId: string) => void nonces.set(nonce, userId)),
  consumeOAuthNonce: vi.fn(async (nonce: string, userId: string) => {
    const owner = nonces.get(nonce);
    nonces.delete(nonce);
    return owner === userId;
  }),
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/meta/client", () => meta);
vi.mock("@/lib/instagram-accounts", () => ({
  canConnectInstagramAccount: vi.fn(async () => ({ allowed: true })),
}));

import { GET } from "@/app/api/instagram/callback/route";
import { createOAuthState, OAUTH_NONCE_COOKIE, STATE_MAX_AGE_MS } from "@/lib/meta/oauth";

const BASE = "https://auto-insta-pi.vercel.app";
const fetchMock = vi.fn();

const NONCE = "nonce_abc";
const validState = (workspaceId = "ws_1", userId = "user_1") =>
  createOAuthState(workspaceId, userId, NONCE);

function callback(params: Record<string, string>, nonce: string | null = NONCE) {
  const url = new URL(`${BASE}/api/instagram/callback`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = nonce ? { cookie: `${OAUTH_NONCE_COOKIE}=${nonce}` } : {};
  return GET(new NextRequest(url, { headers }));
}

function location(response: Response) {
  return new URL(response.headers.get("location")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXTAUTH_URL", BASE);
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-for-state-signing");
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef".repeat(4));
  vi.stubEnv("INSTAGRAM_LOGIN_MODE", "unified");
  vi.stubEnv("INSTAGRAM_APP_ID", "app_123");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "app_secret_value");
  vi.stubEnv("INSTAGRAM_CONFIG_ID", "config_123");
  vi.stubEnv("META_GRAPH_API_VERSION", "v26.0");
  db.operationalEvent.create.mockResolvedValue({});
  nonces.clear();
  nonces.set(NONCE, "user_1");
  authMock.mockResolvedValue({ user: { id: "user_1" } });
  db.workspaceMember.findFirst.mockResolvedValue({ role: "OWNER" });
});

describe("callback rejections (before any Meta call)", () => {
  it("rejects a callback without code", async () => {
    const res = await callback({ state: validState() });
    expect(location(res).searchParams.get("reason")).toBe("missing_code");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a callback without state", async () => {
    const res = await callback({ code: "code_abc" });
    expect(location(res).searchParams.get("instagram")).toBe("invalid");
    expect(location(res).searchParams.get("reason")).toBe("state_missing");
  });

  it("rejects a tampered state", async () => {
    const [payload, sig] = validState().split(".");
    const forged = Buffer.from(JSON.stringify({ workspaceId: "ws_other", ts: Date.now() })).toString("base64url");
    const res = await callback({ code: "code_abc", state: `${forged}.${sig}` });
    expect(location(res).searchParams.get("reason")).toBe("state_bad_signature");
    expect(payload).not.toBe(forged);
  });

  it("rejects an expired state", async () => {
    vi.useFakeTimers();
    const state = validState();
    vi.setSystemTime(Date.now() + STATE_MAX_AGE_MS + 1000);
    const res = await callback({ code: "code_abc", state });
    expect(location(res).searchParams.get("reason")).toBe("state_expired");
  });

  it("accepts a state that took most of the consent window (longer than the old 10 minutes)", async () => {
    vi.useFakeTimers();
    const state = validState();
    vi.setSystemTime(Date.now() + 20 * 60 * 1000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400 }));
    const res = await callback({ code: "code_abc", state });
    expect(location(res).searchParams.get("instagram")).toBe("failed");
  });

  it("maps a Meta cancellation to denied", async () => {
    const res = await callback({ error: "access_denied", error_reason: "user_denied" });
    expect(location(res).searchParams.get("instagram")).toBe("denied");
  });

  it("never logs or redirects with the code or state values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await callback({ code: "SECRET_CODE_123", state: "SECRET_STATE.sig" });
    const logged = JSON.stringify([warn.mock.calls, db.operationalEvent.create.mock.calls]);
    expect(logged).not.toContain("SECRET_CODE_123");
    expect(logged).not.toContain("SECRET_STATE");
    expect(res.headers.get("location")).not.toContain("SECRET");
    warn.mockRestore();
  });
});

describe("state binding", () => {
  it("rejects a state started by another member", async () => {
    const res = await callback({ code: "code_abc", state: validState("ws_1", "user_other") });
    expect(location(res).searchParams.get("reason")).toBe("state_user_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a state replayed without the nonce cookie of the initiating browser", async () => {
    const res = await callback({ code: "code_abc", state: validState() }, null);
    expect(location(res).searchParams.get("reason")).toBe("state_nonce_mismatch");
    const res2 = await callback({ code: "code_abc", state: validState() }, "other_nonce");
    expect(location(res2).searchParams.get("reason")).toBe("state_nonce_mismatch");
  });

  it("lets exactly one of two concurrent callbacks with the same state reach Meta", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "x" } }), { status: 400 }));
    const state = validState();
    const [a, b] = await Promise.all([
      callback({ code: "code_abc", state }),
      callback({ code: "code_abc", state }),
    ]);
    const reasons = [a, b].map((r) => location(r).searchParams.get("reason")).sort();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reasons).toContain("state_already_used");
  });

  it("rejects a second sequential use of the same state even with the cookie preserved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "x" } }), { status: 400 }));
    const state = validState();
    await callback({ code: "code_abc", state });
    const second = await callback({ code: "code_abc", state });
    expect(location(second).searchParams.get("reason")).toBe("state_already_used");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the nonce cookie on the response", async () => {
    const res = await callback({ code: "code_abc", state: validState("ws_1", "user_other") });
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${OAUTH_NONCE_COOKIE}=;`));
  });

  it("does not persist rejections from anonymous requests", async () => {
    authMock.mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await callback({ code: "x", state: "x" });
    expect(db.operationalEvent.create).not.toHaveBeenCalled();
  });
});

describe("authorized callback (Unified Login)", () => {
  it("rejects a member without manage rights", async () => {
    db.workspaceMember.findFirst.mockResolvedValue({ role: "MEMBER" });
    const res = await callback({ code: "code_abc", state: validState() });
    expect(location(res).searchParams.get("instagram")).toBe("forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("links the shared Instagram account to the workspace from the state", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "user-token" })));
    meta.resolveAssignedInstagramAccounts.mockResolvedValue({ accounts: [{ id: "ig_178" }], attempts: 1 });
    meta.getUserInfo.mockResolvedValue({ id: "ig_178", username: "luispagodinsta", name: "Luis" });
    meta.subscribeInstagramAccountToWebhooks.mockResolvedValue({ success: true });
    db.instagramAccount.findUnique.mockResolvedValue(null);
    db.instagramAccount.create.mockResolvedValue({});

    const res = await callback({ code: "code_abc", state: validState() });

    expect(location(res).pathname).toBe("/dashboard");
    const created = db.instagramAccount.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ workspaceId: "ws_1", instagramId: "ig_178", username: "luispagodinsta", provider: "META", webhookSubscribed: true });
    expect(created.accessToken).not.toBe("user-token");
    const tokenRequest = new URL(fetchMock.mock.calls[0][0]);
    expect(tokenRequest.pathname).toBe("/v26.0/oauth/access_token");
  });

  it("reports a failed token exchange without leaking the app secret", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Invalid verification code format." } }), { status: 400 }));
    const res = await callback({ code: "code_abc", state: validState() });
    expect(location(res).searchParams.get("instagram")).toBe("failed");
    expect(location(res).searchParams.get("reason")).toBe("token_exchange_failed");
    expect(res.headers.get("location")).not.toContain("Invalid verification code");
    expect(res.headers.get("location")).not.toContain("app_secret_value");
    expect(JSON.stringify(db.operationalEvent.create.mock.calls)).not.toContain("app_secret_value");
  });
});
