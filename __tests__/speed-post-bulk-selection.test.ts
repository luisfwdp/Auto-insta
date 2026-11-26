import { describe, expect, it } from "vitest";
import { selectAllSpeedPostMedia } from "@/components/publishing/speed-post-workspace";

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
