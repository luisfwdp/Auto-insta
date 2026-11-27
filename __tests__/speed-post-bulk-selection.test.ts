import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SpeedPostWorkspace, { selectAllSpeedPostMedia } from "@/components/publishing/speed-post-workspace";

vi.mock("@/lib/i18n/provider", () => ({
  useI18n: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("@/components/publishing/media-uploader", () => ({ default: () => null }));
vi.mock("@/components/publishing/use-publishing", () => ({
  usePublishingData: () => ({
    loading: false,
    accounts: [],
    media: [],
    batches: [
      { id: "trial", name: "Trial batch", reelMode: "TRIAL", status: "RUNNING", totalItems: 100, publishedItems: 3, failedItems: 0, instagramAccount: { id: "one", username: "creator_trial" } },
      { id: "standard", name: "Standard batch", reelMode: "STANDARD", status: "COMPLETED", totalItems: 4, publishedItems: 4, failedItems: 0, instagramAccount: { id: "two", username: "creator_standard" } },
    ],
  }),
}));

describe("Speed Post bulk selection", () => {
  it("selects a complete 100-video upload without duplicate items", () => {
    const videos = Array.from({ length: 100 }, (_, index) => `video-${index}`);
    expect(selectAllSpeedPostMedia([], videos)).toEqual(videos);
  });

  it("keeps the user's manual order and fills only the remaining batch capacity", () => {
    const videos = Array.from({ length: 120 }, (_, index) => `video-${index}`);
    const selected = ["video-119", "video-3"];
    const result = selectAllSpeedPostMedia(selected, videos);
    expect(result).toHaveLength(100);
    expect(result.slice(0, 5)).toEqual(["video-119", "video-3", "video-0", "video-1", "video-2"]);
    expect(result).toContain("video-98");
    expect(result).not.toContain("video-99");
    expect(new Set(result).size).toBe(100);
    expect(selected).toEqual(["video-119", "video-3"]);
    expect(videos).toHaveLength(120);
  });

  it("is idempotent when selecting all repeatedly or after individual selection", () => {
    const videos = ["first", "second", "third"];
    const once = selectAllSpeedPostMedia(["second"], videos);
    expect(once).toEqual(["second", "first", "third"]);
    expect(selectAllSpeedPostMedia(once, videos)).toEqual(once);
  });
});

it("identifies the publishing account and explains where to find published Trial Reels", () => {
  const html = renderToStaticMarkup(createElement(SpeedPostWorkspace));
  const articles = html.match(/<article\b[\s\S]*?<\/article>/g) ?? [];
  expect(articles).toHaveLength(2);
  expect(articles[0]).toContain("@creator_trial");
  expect(articles[0]).toContain("3/100 published as Trial Reels");
  expect(articles[0]).toContain("beside its drafts");
  expect(articles[1]).toContain("@creator_standard");
  expect(articles[1]).toContain("4/4 published");
  expect(articles[1]).not.toContain("beside its drafts");
});
