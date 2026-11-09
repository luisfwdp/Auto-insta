import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertContentPublishPermission,
  createPublishContainer,
  getContentPublishingLimit,
  publishInstagramMedia,
  waitForContainer,
} from "../lib/instagram/publish-content";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("official Instagram content publishing client", () => {
  beforeEach(() => {
    process.env.INSTAGRAM_LOGIN_MODE = "facebook";
    process.env.META_GRAPH_API_VERSION = "v25.0";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("checks the content publishing permission without putting the token in the URL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: [
      { permission: "instagram_content_publish", status: "granted" },
    ] }));
    await assertContentPublishPermission("secret-token");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).not.toContain("secret-token");
    expect(init?.headers).toEqual({ Authorization: "Bearer secret-token" });
  });

  it("reads the connected account's real publishing quota", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: [{
      quota_usage: 7,
      config: { quota_total: 50, quota_duration: 86_400 },
    }] }));
    await expect(getContentPublishingLimit("ig-123", "token")).resolves.toEqual({
      quotaUsage: 7,
      quotaTotal: 50,
      quotaDurationSeconds: 86_400,
    });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("ig-123/content_publishing_limit");
  });

  it("sends Trial Reels explicitly and never silently downgrades them", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ id: "container-1" }));
    await createPublishContainer("ig-123", "token", {
      kind: "REEL",
      url: "https://signed.example/reel.mp4",
      trial: true,
      trialGraduationStrategy: "MANUAL",
    }, "Legenda");
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("media_type")).toBe("REELS");
    expect(body.get("trial_params")).toBe('{"graduation_strategy":"MANUAL"}');
    expect(body.get("caption")).toBe("Legenda");
  });

  it("creates carousel children before its parent", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ id: "child-a" }))
      .mockResolvedValueOnce(response({ id: "child-b" }))
      .mockResolvedValueOnce(response({ id: "parent" }));
    await expect(createPublishContainer("ig-123", "token", {
      kind: "CAROUSEL",
      children: [
        { kind: "IMAGE", url: "https://signed.example/a.jpg" },
        { kind: "VIDEO", url: "https://signed.example/b.mp4" },
      ],
    }, "Álbum")).resolves.toBe("parent");
    const parentBody = new URLSearchParams(String(vi.mocked(fetch).mock.calls[2][1]?.body));
    expect(parentBody.get("children")).toBe("child-a,child-b");
    expect(parentBody.get("media_type")).toBe("CAROUSEL");
  });

  it("polls processing to completion, then publishes the container", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ id: "container-1" }))
      .mockResolvedValueOnce(response({ id: "container-1", status_code: "IN_PROGRESS" }))
      .mockResolvedValueOnce(response({ id: "container-1", status_code: "FINISHED" }));
    const sleeps: number[] = [];
    // Exercise the injectable poller separately so this test remains instant.
    await createPublishContainer("ig-123", "token", { kind: "IMAGE", url: "https://signed.example/a.jpg" }, "x");
    await waitForContainer("container-1", "token", { intervalMs: 25, sleep: async (ms) => { sleeps.push(ms); } });
    // publishInstagramMedia's orchestration is covered with an already-finished container.
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ id: "container-2" }))
      .mockResolvedValueOnce(response({ id: "container-2", status_code: "FINISHED" }))
      .mockResolvedValueOnce(response({ id: "media-1" }));
    await expect(publishInstagramMedia({
      instagramAccountId: "ig-123", accessToken: "token", caption: "x",
      media: { kind: "IMAGE", url: "https://signed.example/a.jpg" },
    })).resolves.toEqual({ containerId: "container-2", mediaId: "media-1" });
    expect(sleeps).toEqual([25]);
  });

  it("surfaces account ineligibility errors instead of pretending Trial support", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: {
      message: "Account is not eligible for trial reels", code: 100, fbtrace_id: "anon-trace",
    } }, 400));
    await expect(createPublishContainer("ig-123", "token", {
      kind: "REEL", url: "https://signed.example/reel.mp4", trial: true,
    }, "x")).rejects.toThrow("Account is not eligible");
  });
});
