import { describe, expect, it } from "vitest";
import { mediaSelectionError } from "@/components/publishing/media-uploader";

describe("media selection before reserving private storage", () => {
  it("accepts the complete 100-video Speed Post batch but rejects 101", () => {
    const files = Array.from({ length: 100 }, () => ({ type: "video/mp4" }));
    expect(mediaSelectionError(files, true, true)).toBeNull();
    expect(mediaSelectionError([...files, files[0]], true, true)).toBe("LIMIT");
  });
  it.each(["image/jpeg", "video/mp4", "video/quicktime"])("preserves scheduling support for %s", type => {
    expect(mediaSelectionError([{ type }])).toBeNull();
  });
  it.each(["image/png", "text/html", "", "video/mpeg"])("rejects unsupported dropped files (%s)", type => {
    expect(mediaSelectionError([{ type }])).toBe("TYPE");
  });
  it("rejects mixed image/video drops for the Reels-only Speed Post", () => {
    expect(mediaSelectionError([{ type: "video/mp4" }, { type: "image/jpeg" }], true, true)).toBe("TYPE");
  });
  it("honors a single-file consumer even when a drop includes multiple files", () => {
    expect(mediaSelectionError([{ type: "image/jpeg" }], false)).toBeNull();
    expect(mediaSelectionError([{ type: "image/jpeg" }, { type: "video/mp4" }], false)).toBe("LIMIT");
  });
});
