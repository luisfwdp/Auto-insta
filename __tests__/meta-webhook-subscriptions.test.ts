import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeInstagramAccountToWebhooks } from "@/lib/meta/client";
import { subscribePageToWebhooks } from "@/lib/meta/facebook-login";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("META_GRAPH_API_VERSION", "v26.0");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Instagram interactive webhook subscriptions", () => {
  it.each([
    ["legacy", "graph.instagram.com"],
    ["unified", "graph.facebook.com"],
  ])("requests the IG User interactive fields in %s mode", async (mode, host) => {
    vi.stubEnv("INSTAGRAM_LOGIN_MODE", mode);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));

    await expect(subscribeInstagramAccountToWebhooks("ig_test", "anonymous-token")).resolves.toEqual({ success: true });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${host}/v26.0/ig_test/subscribed_apps`);
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer anonymous-token");
    expect(JSON.parse(options.body)).toEqual({
      subscribed_fields: ["comments", "messages", "messaging_postbacks", "messaging_seen"],
    });
    expect(url).not.toContain("anonymous-token");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("propagates Meta rejection instead of silently subscribing fewer fields", async () => {
    vi.stubEnv("INSTAGRAM_LOGIN_MODE", "legacy");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 100, message: "Anonymous subscription rejection" } }), { status: 400 }));
    await expect(subscribeInstagramAccountToWebhooks("ig_test", "anonymous-token")).rejects.toThrow("Anonymous subscription rejection");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the Facebook Page endpoint and its separate field list unchanged", async () => {
    vi.stubEnv("INSTAGRAM_LOGIN_MODE", "facebook");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    await subscribePageToWebhooks("page_test", "anonymous-page-token");
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v26.0/page_test/subscribed_apps");
    expect(url.searchParams.get("subscribed_fields")).toBe("feed,messages");
    expect(url.searchParams.get("subscribed_fields")).not.toContain("messaging_seen");
  });
});
