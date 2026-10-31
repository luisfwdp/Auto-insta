import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeCodeForToken,
  getAuthorizationUrl,
} from "@/lib/meta/oauth";
import {
  getAssignedInstagramAccounts,
  getUserInfo,
  getUserMedia,
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
    expect(url.searchParams.get("override_default_response_type")).toBe(
      "true"
    );
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
    expect(request.searchParams.get("redirect_uri")).toBe(
      "https://example.com/api/instagram/callback"
    );
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
