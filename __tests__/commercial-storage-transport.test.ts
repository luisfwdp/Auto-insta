import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignedUpload, getPrivateBucketUploadLimit, inspectPrivateObject, deletePrivateObject, createSignedDownload, SIGNED_UPLOAD_TTL_MS } from "../lib/publishing/storage";
const origin = "https://storage.example.test", bucket = "instagram-publishing", path = "workspace_a/file.jpg";
const uploadPath = `/storage/v1/object/upload/sign/${bucket}/${path}`;
const key = "fake-service-role-key-for-local-unit-tests";
const fetcher = vi.fn();
beforeEach(() => {
  vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("SUPABASE_URL", origin); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key); vi.stubEnv("SUPABASE_MEDIA_BUCKET", bucket);
  fetcher.mockReset(); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("commercial private storage transport", () => {
  it("uses real bucket metadata with fixed-origin auth and never a declared request size", async () => {
    fetcher.mockResolvedValue(Response.json({ id: bucket, public: false, file_size_limit: 300 * 1024 * 1024 }));
    expect(await getPrivateBucketUploadLimit()).toBe(300 * 1024 * 1024);
    expect(fetcher).toHaveBeenCalledWith(`${origin}/storage/v1/bucket/${bucket}`, expect.objectContaining({ redirect: "error", cache: "no-store", headers: { apikey: key, Authorization: `Bearer ${key}` } }));
    expect(fetcher.mock.calls[0][0]).not.toContain(key);
  });
  it.each([{ file_size_limit: null }, { file_size_limit: 0 }, { file_size_limit: -1 }, { file_size_limit: "300MB" }, { file_size_limit: 1.5 }, { public: true }, { id: "foreign-bucket" }])("rejects unlimited/invalid/public bucket metadata %#", async patch => {
    fetcher.mockResolvedValue(Response.json({ id: bucket, public: false, file_size_limit: 1000, ...patch }));
    await expect(getPrivateBucketUploadLimit()).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["url only", "url and token"])("accepts the official %s signing response and enforces non-upsert via header", async variant => {
    const token = "fake-token";
    fetcher.mockResolvedValue(Response.json({ url: `${uploadPath.replace('/storage/v1', '')}?token=${token}`, ...(variant === "url and token" ? { token } : {}) }));
    const before = Date.now(), result = await createSignedUpload(path);
    expect(result).toMatchObject({ uploadUrl: `${origin}${uploadPath}?token=${token}`, token });
    expect("expiresAt" in result && result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SIGNED_UPLOAD_TTL_MS);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", headers: { "x-upsert": "false" }, body: "{}" });
  });
  it.each([`https://evil.example${uploadPath}?token=fake`, `https://storage.example.test.evil.example${uploadPath}?token=fake`,
    `https://user:password@storage.example.test${uploadPath}?token=fake`, `https://@storage.example.test${uploadPath}?token=fake`,
    `http://storage.example.test${uploadPath}?token=fake`, `${origin}${uploadPath}?token=fake#fragment`, `${origin}/storage/v1/object/upload/sign/${bucket}/foreign/file.jpg?token=fake`])("rejects cross-origin/credentialed/foreign-path signed URLs %#", async url => {
    fetcher.mockResolvedValue(Response.json({ url })); await expect(createSignedUpload(path)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects token mismatches and validates visible JWT expiry without printing the token", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ url: `${uploadPath}?token=one`, token: "other" }));
    await expect(createSignedUpload(path)).rejects.toThrow();
    const token = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
    const expires = Math.floor(Date.now() / 1000) + 3600, validToken = token(expires);
    fetcher.mockResolvedValueOnce(Response.json({ url: `${uploadPath}?token=${validToken}` }));
    const valid = await createSignedUpload(path); expect("expiresAt" in valid && valid.expiresAt.getTime()).toBe(expires * 1000);
    const overwriteToken = `header.${Buffer.from(JSON.stringify({ exp: expires, upsert: true })).toString("base64url")}.signature`;
    fetcher.mockResolvedValueOnce(Response.json({ url: `${uploadPath}?token=${overwriteToken}` })); await expect(createSignedUpload(path)).rejects.toThrow("overwrites");
    for (const exp of [1, Math.floor(Date.now() / 1000) + 86400]) {
      fetcher.mockResolvedValueOnce(Response.json({ url: `${uploadPath}?token=${token(exp)}` })); await expect(createSignedUpload(path)).rejects.toThrow();
    }
  });
  it("HEADs actual size and reads bounded multi-chunk magic bytes instead of trusting declared bytes", async () => {
    fetcher.mockResolvedValueOnce(new Response(null, { headers: { "content-length": "500", "content-type": "image/jpeg" } }));
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([255])); controller.enqueue(new Uint8Array([216, 255, 224])); controller.close(); } });
    fetcher.mockResolvedValueOnce(new Response(stream, { status: 206, headers: { "content-range": "bytes 0-3/500" } }));
    const result = await inspectPrivateObject(path); expect(result).toMatchObject({ byteSize: 500, contentType: "image/jpeg", prefix: new Uint8Array([255, 216, 255, 224]) });
    expect(fetcher.mock.calls[0][1].method).toBe("HEAD"); expect(fetcher.mock.calls[1][1].headers.Range).toBe("bytes=0-31");
    for (const [url, init] of fetcher.mock.calls) { expect(url).toBe(`${origin}/storage/v1/object/authenticated/${bucket}/${path}`); expect(init.redirect).toBe("error"); }
  });
  it("accepts only definitive404 as absence and never converts forbidden/provider errors into absence", async () => {
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 })); expect(await inspectPrivateObject(path)).toBeNull();
    for (const status of [401, 403, 500]) { fetcher.mockResolvedValueOnce(new Response(null, { status })); await expect(inspectPrivateObject(path)).rejects.toThrow(); }
  });
  it("rejects contradictory HEAD/range sizes without downloading the whole file", async () => {
    fetcher.mockResolvedValueOnce(new Response(null, { headers: { "content-length": "500" } }));
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255]), { status: 206, headers: { "content-range": "bytes 0-2/800" } }));
    await expect(inspectPrivateObject(path)).rejects.toThrow("changed");
  });
  it("never follows redirects or surfaces provider bodies on sign/delete failures", async () => {
    for (const run of [() => createSignedUpload(path), () => deletePrivateObject(path)]) {
      fetcher.mockResolvedValueOnce(new Response(key, { status: 503 })); let error: unknown; try { await run(); } catch (caught) { error = caught; }
      expect(String(error)).not.toContain(key);
    }
    for (const [, init] of fetcher.mock.calls) expect(init.redirect).toBe("error");
  });
  it("validates download signed URLs against the same private storage origin", async () => {
    const signedPath = `/storage/v1/object/sign/${bucket}/${path}`;
    fetcher.mockResolvedValueOnce(Response.json({ signedURL: `${signedPath}?token=fake` })); expect(await createSignedDownload(path)).toBe(`${origin}${signedPath}?token=fake`);
    fetcher.mockResolvedValueOnce(Response.json({ signedURL: "https://evil.example/steal" })); await expect(createSignedDownload(path)).rejects.toThrow();
  });
  it("keeps the original legacy signing request/response when commercial mode is disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false"); fetcher.mockResolvedValue(Response.json({ url: `/object/upload/sign/${bucket}/${path}?token=fake`, token: "fake" }));
    expect(await createSignedUpload(path)).toEqual({ uploadUrl: `${origin}${uploadPath}?token=fake`, token: "fake" });
    expect(fetcher.mock.calls[0][1]).toEqual({ method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ upsert: false }) });
  });
});
