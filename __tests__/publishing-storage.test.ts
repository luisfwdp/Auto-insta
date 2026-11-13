import { describe, expect, it } from "vitest";
import { matchesDeclaredMedia } from "@/lib/publishing/storage";
import { MEDIA_FILE_ACCEPT } from "@/components/publishing/media-uploader";
import { ALLOWED_MEDIA } from "@/lib/publishing/schemas";

describe("private publishing media validation", () => {
  it("keeps the browser picker aligned with media accepted by the API", () => {
    expect(MEDIA_FILE_ACCEPT.split(",").sort()).toEqual(Object.keys(ALLOWED_MEDIA).sort());
  });

  it("accepts JPEG and rejects executable content declared as an image", () => {
    expect(matchesDeclaredMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "IMAGE")).toBe(true);
    expect(matchesDeclaredMedia(new TextEncoder().encode("MZ executable"), "IMAGE")).toBe(false);
  });

  it("accepts ISO base media containers and rejects renamed files", () => {
    const mp4 = new Uint8Array(12);
    mp4.set(new TextEncoder().encode("ftyp"), 4);
    expect(matchesDeclaredMedia(mp4, "VIDEO")).toBe(true);
    expect(matchesDeclaredMedia(new TextEncoder().encode("not a video"), "VIDEO")).toBe(false);
  });
});
