/**
 * Instagram API with Facebook Login (INSTAGRAM_LOGIN_MODE=facebook): scope-based
 * dialog, long-lived user token, Instagram account resolved from the Page.
 * Payloads are anonymised.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FACEBOOK_LOGIN_SCOPES,
  exchangeForLongLivedUserToken,
  resolvePageInstagramAccounts,
  subscribePageToWebhooks,
} from "@/lib/meta/facebook-login";
import { exchangeCodeForToken, getAuthorizationUrl } from "@/lib/meta/oauth";

const fetchMock = vi.fn();
const respond = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("INSTAGRAM_LOGIN_MODE", "facebook");
  vi.stubEnv("INSTAGRAM_APP_ID", "app_123");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "secret_value");
  vi.stubEnv("META_GRAPH_API_VERSION", "v26.0");
  vi.stubEnv("INSTAGRAM_FACEBOOK_SCOPES", "");
});

describe("Facebook Login mode", () => {
  it("asks for the Page and Instagram permissions by scope, without config_id", () => {
    const url = new URL(getAuthorizationUrl("https://x.test/api/instagram/callback", "st"));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(url.searchParams.get("scope")?.split(",")).toEqual(DEFAULT_FACEBOOK_LOGIN_SCOPES);
    expect(url.searchParams.get("scope")).toContain("pages_show_list");
    expect(url.searchParams.get("scope")).toContain("pages_manage_metadata");
    expect(url.searchParams.has("config_id")).toBe(false);
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("exchanges the code on graph.facebook.com with the dialog's redirect_uri", async () => {
    respond({ access_token: "short" });
    await exchangeCodeForToken("code_1", "https://x.test/api/instagram/callback");
    const req = new URL(fetchMock.mock.calls[0][0]);
    expect(req.pathname).toBe("/v26.0/oauth/access_token");
    expect(req.searchParams.get("redirect_uri")).toBe("https://x.test/api/instagram/callback");
  });

  it("exchanges for a long-lived user token", async () => {
    respond({ access_token: "long" });
    await expect(exchangeForLongLivedUserToken("short")).resolves.toBe("long");
    const req = new URL(fetchMock.mock.calls[0][0]);
    expect(req.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(req.searchParams.get("fb_exchange_token")).toBe("short");
  });

  it("keeps only Pages with a linked Instagram professional account", async () => {
    respond({
      data: [
        { id: "page_1", name: "P1", access_token: "page_tok", instagram_business_account: { id: "ig_1", username: "acct" } },
        { id: "page_2", name: "P2", access_token: "page_tok2" },
      ],
    });
    const result = await resolvePageInstagramAccounts("long");
    expect(result).toEqual({
      pageCount: 2,
      accounts: [{ pageId: "page_1", pageName: "P1", pageAccessToken: "page_tok", instagramId: "ig_1", username: "acct" }],
    });
  });

  it("surfaces Meta's error without the token-bearing URL", async () => {
    respond({ error: { message: "Invalid scope" } }, 400);
    await expect(resolvePageInstagramAccounts("secret_user_token")).rejects.toThrow("Invalid scope");
  });

  it("installs the app on the Page for webhooks", async () => {
    respond({ success: true });
    await expect(subscribePageToWebhooks("page_1", "page_tok")).resolves.toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v26.0/page_1/subscribed_apps");
    expect(init.method).toBe("POST");
  });
});
