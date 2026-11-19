import { afterEach, describe, expect, it, vi } from "vitest";
import { createDedupeFetch } from "next/dist/server/lib/dedupe-fetch";
import { inspectPrivateObject, matchesDeclaredMedia } from "@/lib/publishing/storage";
import { MEDIA_FILE_ACCEPT } from "@/components/publishing/media-uploader";
import { ALLOWED_MEDIA } from "@/lib/publishing/schemas";

describe("private publishing media validation", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  function storageFixture() {
    vi.stubEnv("SUPABASE_URL", "https://storage.example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-storage-key");
    const prefix = new Uint8Array(32);
    prefix.set(new TextEncoder().encode("ftyp"), 4);
    return new Response(prefix, { status: 206, headers: {
      "content-range": "bytes 0-31/75974", "content-length": "32", "content-type": "video/mp4",
    } });
  }

  it("finishes range inspection with the installed Next.js fetch deduplicator", async () => {
    const response = storageFixture();
    const originalFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", createDedupeFetch(originalFetch));
    const inspection = inspectPrivateObject("fixture-workspace/test.mp4", { commercial: false });
    const inspected = await Promise.race([
      inspection,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Range inspection did not finish")), 500)),
    ]);
    expect(inspected).toMatchObject({ byteSize: 75974, contentType: "video/mp4" });
    expect(matchesDeclaredMedia(inspected!.prefix, "VIDEO")).toBe(true);
    expect(originalFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Range: "bytes=0-31" }),
    }));
  });

  it("does not wait for cancellation of a cloned response's retained branch", async () => {
    const response = storageFixture();
    const retained = response.clone();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    try {
      const inspected = await Promise.race([
        inspectPrivateObject("fixture-workspace/test.mp4", { commercial: false }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Cancellation blocked inspection")), 500)),
      ]);
      expect(inspected?.byteSize).toBe(75974);
      expect(matchesDeclaredMedia(inspected!.prefix, "VIDEO")).toBe(true);
    } finally { await retained.arrayBuffer(); }
  });

  it("still rejects an unavailable object without marking it ready", async () => {
    storageFixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    expect(await inspectPrivateObject("fixture-workspace/missing.mp4", { commercial: false })).toBeNull();
  });

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
