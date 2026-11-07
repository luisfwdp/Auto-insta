import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeCodeForToken,
  getAuthorizationUrl,
} from "@/lib/meta/oauth";
import {
  getAssignedInstagramAccounts,
  getUserInfo,
  getUserMedia,
  resolveAssignedInstagramAccounts,
} from "@/lib/meta/client";

const fetchMock = vi.fn();

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status })
  );
}

describe("Meta Unified Login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("INSTAGRAM_LOGIN_MODE", "unified");
    vi.stubEnv("INSTAGRAM_APP_ID", "app_123");
    vi.stubEnv("INSTAGRAM_APP_SECRET", "app_secret");
    vi.stubEnv("INSTAGRAM_CONFIG_ID", "config_123");
    vi.stubEnv("META_GRAPH_API_VERSION", "v26.0");
  });

  it("builds the Facebook Login for Business URL with signed state", () => {
    const url = new URL(
      getAuthorizationUrl("https://example.com/api/instagram/callback", "state")
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://www.facebook.com/dialog/oauth"
    );
    expect(url.searchParams.get("client_id")).toBe("app_123");
    expect(url.searchParams.get("config_id")).toBe("config_123");
    expect(url.searchParams.has("override_default_response_type")).toBe(false);
    expect(url.searchParams.has("display")).toBe(false);
    expect(url.searchParams.get("state")).toBe("state");
  });

  it("exchanges the callback code on graph.facebook.com", async () => {
    respond({ access_token: "system-user-token" });
    await expect(
      exchangeCodeForToken(
        "code_123",
        "https://example.com/api/instagram/callback"
      )
    ).resolves.toEqual({ accessToken: "system-user-token" });

    const request = new URL(fetchMock.mock.calls[0][0]);
    expect(`${request.origin}${request.pathname}`).toBe(
      "https://graph.facebook.com/v26.0/oauth/access_token"
    );
    expect(request.searchParams.get("code")).toBe("code_123");
    expect(request.searchParams.get("redirect_uri")).toBe("https://example.com/api/instagram/callback");
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: "no-store" });
  });

  it("resolves only the Instagram account shared by the customer", async () => {
    respond({ data: [{ id: "ig_123", username: "authorized_account" }] });
    await expect(
      getAssignedInstagramAccounts("system-user-token")
    ).resolves.toEqual([{ id: "ig_123", username: "authorized_account" }]);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "graph.facebook.com/v26.0/me/assigned_instagram_accounts"
    );
  });

  it("retries an empty assigned-account response before succeeding", async () => {
    respond({ data: [] });
    respond({ data: [{ id: "ig_123", username: "authorized_account" }] });

    await expect(
      resolveAssignedInstagramAccounts("system-user-token", { maxAttempts: 3, delayMs: 0 })
    ).resolves.toEqual({
      accounts: [{ id: "ig_123", username: "authorized_account" }],
      attempts: 2,
      source: "assigned",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the Instagram account linked to the token's Page", async () => {
    respond({ data: [] });
    respond({ client_business_id: "business_123" });
    respond({ data: [{ permission: "instagram_basic", status: "granted" }, { permission: "x", status: "declined" }] });
    respond({ data: [{ instagram_business_account: { id: "ig_9", username: "luis" } }, {}] });

    const result = await resolveAssignedInstagramAccounts("system-user-token", { maxAttempts: 1, delayMs: 0 });
    expect(result).toMatchObject({
      accounts: [{ id: "ig_9", username: "luis" }],
      source: "pages",
      clientBusinessId: "business_123",
      diagnostics: { grantedPermissions: ["instagram_basic"], lookups: { assigned: 0, pages: 1 } },
    });
    expect(new URL(fetchMock.mock.calls[3][0]).pathname).toBe("/v26.0/me/accounts");
  });

  it("falls back to the client business's owned accounts when Pages are not shared", async () => {
    respond({ data: [] });
    respond({ client_business_id: "business_123" });
    respond({ data: [] });
    respond({ error: { code: 200, message: "secret-ish detail" } }, 400);
    respond({ data: [{ id: "ig_9", username: "luis" }] });

    const result = await resolveAssignedInstagramAccounts("system-user-token", { maxAttempts: 1, delayMs: 0 });
    expect(result).toMatchObject({ accounts: [{ id: "ig_9" }], source: "business" });
    expect(result.diagnostics?.lookups).toEqual({ assigned: 0, pages: "error_200", business: 1 });
    expect(JSON.stringify(result)).not.toContain("secret-ish detail");
    expect(new URL(fetchMock.mock.calls[4][0]).pathname).toBe("/v26.0/business_123/owned_instagram_accounts");
  });

  it("returns safe diagnostics, without the token, when every lookup is empty", async () => {
    respond({ data: [] });
    respond({ data: [] });
    respond({ client_business_id: "business_123" });
    respond({ data: [] });
    respond({ data: [] });
    respond({ data: [] });

    const result = await resolveAssignedInstagramAccounts("system-user-token", { maxAttempts: 2, delayMs: 0 });
    expect(result).toEqual({
      accounts: [],
      attempts: 2,
      clientBusinessId: "business_123",
      diagnostics: { grantedPermissions: [], lookups: { assigned: 0, pages: 0, business: 0 } },
    });
    expect(JSON.stringify(result)).not.toContain("system-user-token");
  });

  it("uses the selected account id for profile and media calls", async () => {
    respond({ id: "ig_123", username: "authorized_account" });
    await getUserInfo("system-user-token", "ig_123");
    respond({ data: [{ id: "media_123" }] });
    await getUserMedia("system-user-token", "ig_123", 3);

    expect(fetchMock.mock.calls[0][0]).toContain(
      "graph.facebook.com/v26.0/ig_123?"
    );
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("fields"))
      .not.toContain("user_id");
    expect(fetchMock.mock.calls[1][0]).toContain(
      "graph.facebook.com/v26.0/ig_123/media?"
    );
  });
});
