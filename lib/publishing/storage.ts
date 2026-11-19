import { isBillingEnabled } from "@/lib/billing/trial";

const DEFAULT_BUCKET = "instagram-publishing";

function config() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_MEDIA_BUCKET || DEFAULT_BUCKET;
  if (!url || !serviceKey) throw new Error("Private media storage is not configured");
  return { url, serviceKey, bucket };
}

function headers(serviceKey: string, contentType?: string) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

function objectPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function mediaStoragePath(workspaceId: string, id: string, filename: string) {
  const extension = filename.toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] ?? "";
  return `${workspaceId}/${id}${extension}`;
}

export async function createSignedUpload(storagePath: string, options = { commercial: isBillingEnabled() }) {
  if (options.commercial) return commercialSignedUpload(storagePath);
  const { url, serviceKey, bucket } = config();
  const response = await fetch(`${url}/storage/v1/object/upload/sign/${encodeURIComponent(bucket)}/${objectPath(storagePath)}`, {
    method: "POST",
    headers: headers(serviceKey, "application/json"),
    body: JSON.stringify({ upsert: false }),
  });
  if (!response.ok) throw new Error(`Storage rejected the upload request (${response.status})`);
  const payload = await response.json() as { url?: string; signedURL?: string; token?: string };
  const relative = payload.url ?? payload.signedURL;
  const uploadUrl = relative?.startsWith("http") ? relative : relative ? `${url}/storage/v1${relative}` : null;
  if (!uploadUrl || !payload.token) throw new Error("Storage returned an invalid signed upload response");
  return { uploadUrl, token: payload.token };
}

export async function inspectPrivateObject(storagePath: string, options = { commercial: isBillingEnabled() }) {
  if (options.commercial) return commercialInspect(storagePath);
  const { url, serviceKey, bucket } = config();
  const response = await fetch(`${url}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${objectPath(storagePath)}`, {
    headers: { ...headers(serviceKey), Range: "bytes=0-31" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return null;
  const contentRange = response.headers.get("content-range");
  const rangeSize = contentRange?.match(/\/(\d+)$/)?.[1];
  const byteSize = Number(rangeSize ?? response.headers.get("content-length"));
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) return null;
  const reader = response.body?.getReader();
  const first = await reader?.read();
  // A framework-retained tee branch can keep cancel() pending indefinitely.
  // Request cancellation without making validated metadata wait for that branch.
  void reader?.cancel().catch(() => undefined);
  return {
    byteSize,
    contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null,
    prefix: first?.value?.slice(0, 32) ?? new Uint8Array(),
  };
}

export function matchesDeclaredMedia(prefix: Uint8Array, mediaType: "IMAGE" | "VIDEO") {
  const jpeg = prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  const isoVideo = prefix.length >= 12 && new TextDecoder().decode(prefix.slice(4, 8)) === "ftyp";
  return mediaType === "IMAGE" ? jpeg : isoVideo;
}

/** Short-lived URL for Meta to fetch an object. Never persist this value. */
export async function createSignedDownload(storagePath: string, expiresInSeconds = 900) {
  if (isBillingEnabled()) return commercialSignedDownload(storagePath, expiresInSeconds);
  const { url, serviceKey, bucket } = config();
  const response = await fetch(`${url}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${objectPath(storagePath)}`, {
    method: "POST",
    headers: headers(serviceKey, "application/json"),
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!response.ok) throw new Error(`Storage rejected the download request (${response.status})`);
  const payload = await response.json() as { signedURL?: string; signedUrl?: string };
  const relative = payload.signedURL ?? payload.signedUrl;
  if (!relative) throw new Error("Storage returned an invalid signed download response");
  return relative.startsWith("http") ? relative : `${url}/storage/v1${relative}`;
}

export async function deletePrivateObject(storagePath: string, options = { commercial: isBillingEnabled() }) {
  if (options.commercial) return commercialDelete(storagePath);
  const { url, serviceKey, bucket } = config();
  const response = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}`, {
    method: "DELETE",
    headers: headers(serviceKey, "application/json"),
    body: JSON.stringify({ prefixes: [storagePath] }),
  });
  if (!response.ok && response.status !== 404) throw new Error(`Storage rejected deletion (${response.status})`);
}


// Supabase restrictions are bucket-wide, not a declared per-request byte limit.
// https://supabase.com/docs/guides/storage/buckets/fundamentals
// Signed upload tokens last two hours and default to non-upsert; the signing
// endpoint reads x-upsert, not the JSON body. No SDK or per-token file cap exists.
// https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl
export const SIGNED_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
function commercialConfig() {
  const value = config();
  let parsed: URL;
  try { parsed = new URL(value.url); } catch { throw new Error("Storage configuration unavailable"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error("Storage configuration unavailable");
  return { ...value, url: parsed.origin };
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Storage response unavailable");
  let bytes = 0, text = ""; const decoder = new TextDecoder();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
    if (bytes > 65536) { await reader.cancel(); throw new Error("Storage response unavailable"); } text += decoder.decode(chunk.value, { stream: true }); }
  const result: unknown = JSON.parse(text + decoder.decode());
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Storage response unavailable");
  return result as Record<string, unknown>;
}
function signedUrl(value: unknown, origin: string, path: string) {
  if (typeof value !== "string" || !value || value.length > 16384 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) || value.includes("\\") || value.includes("#")) throw new Error("Storage signed URL unavailable");
  const absolute = value.startsWith("/object/") ? `${origin}/storage/v1${value}` : value.startsWith("/storage/v1/") ? `${origin}${value}` : value;
  let result: URL;
  try { result = new URL(absolute); } catch { throw new Error("Storage signed URL unavailable"); }
  if (/^https:\/\/([^/?#]+)/i.exec(absolute)?.[1].includes("@")) throw new Error("Storage signed URL unavailable");
  if (result.origin !== origin || result.protocol !== "https:" || result.username || result.password || result.hash || result.pathname !== path) throw new Error("Storage signed URL unavailable");
  return result;
}
async function storageFetch(url: string, serviceKey: string, init: RequestInit = {}) {
  try { return await fetch(url, { ...init, headers: { ...headers(serviceKey), ...init.headers }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error("Storage request unavailable"); }
}
export async function getPrivateBucketUploadLimit() {
  const { url, serviceKey, bucket } = commercialConfig();
  const response = await storageFetch(`${url}/storage/v1/bucket/${encodeURIComponent(bucket)}`, serviceKey);
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("Storage bucket unavailable"); }
  const body = await boundedJson(response), limit = body.file_size_limit;
  if (body.id !== bucket || body.public !== false || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) throw new Error("Storage bucket must be private with a finite upload limit");
  return limit;
}
async function commercialSignedUpload(storagePath: string) {
  const { url, serviceKey, bucket } = commercialConfig();
  const path = `/storage/v1/object/upload/sign/${encodeURIComponent(bucket)}/${objectPath(storagePath)}`;
  const response = await storageFetch(`${url}${path}`, serviceKey, { method: "POST", headers: { "Content-Type": "application/json", "x-upsert": "false" }, body: "{}" });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("Storage upload unavailable"); }
  const body = await boundedJson(response), result = signedUrl(body.url ?? body.signedURL, url, path);
  const queryToken = result.searchParams.get("token"), token = body.token ?? queryToken;
  if (typeof token !== "string" || !token || token.length > 8192 || /\s/.test(token) || (queryToken && token !== queryToken)) throw new Error("Storage upload token unavailable");
  if (!queryToken) result.searchParams.set("token", token);
  const now = Date.now(); let expiresAt = new Date(now + SIGNED_UPLOAD_TTL_MS);
  if (token.split(".").length === 3) {
    let claims: unknown;
    try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch { throw new Error("Storage upload token unavailable"); }
    if (claims && typeof claims === "object" && "upsert" in claims && claims.upsert === true) throw new Error("Storage upload must not allow overwrites");
    const exp = claims && typeof claims === "object" && "exp" in claims ? claims.exp : null;
    if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp * 1000 <= now || exp * 1000 > now + SIGNED_UPLOAD_TTL_MS + 60000) throw new Error("Storage upload token expiry unavailable");
    expiresAt = new Date(exp * 1000);
  }
  return { uploadUrl: result.href, token, expiresAt };
}
async function commercialInspect(storagePath: string) {
  const { url, serviceKey, bucket } = commercialConfig();
  const path = `${url}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${objectPath(storagePath)}`;
  const head = await storageFetch(path, serviceKey, { method: "HEAD" });
  if (head.status === 404) return null;
  if (!head.ok) throw new Error("Storage object metadata unavailable");
  const length = head.headers.get("content-length"), byteSize = length && /^\d+$/.test(length) ? Number(length) : NaN;
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error("Storage object metadata unavailable");
  const response = await storageFetch(path, serviceKey, { headers: { Range: "bytes=0-31" } });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("Storage object content unavailable"); }
  const total = response.status === 206 ? response.headers.get("content-range")?.match(/^bytes 0-\d+\/(\d+)$/)?.[1] : response.headers.get("content-length");
  if (Number(total) !== byteSize) { await response.body?.cancel().catch(() => {}); throw new Error("Storage object changed during inspection"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Storage object content unavailable");
  const prefix = new Uint8Array(32); let used = 0;
  try { while (used < 32) { const chunk = await reader.read(); if (chunk.done) break; const part = chunk.value.slice(0, 32 - used); prefix.set(part, used); used += part.length; } }
  finally { await reader.cancel().catch(() => {}); }
  return { byteSize, contentType: head.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null, prefix: prefix.slice(0, used) };
}
async function commercialDelete(storagePath: string) {
  const { url, serviceKey, bucket } = commercialConfig();
  const response = await storageFetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}`, serviceKey, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [storagePath] }) });
  if (!response.ok && response.status !== 404) throw new Error("Storage deletion unavailable");
  await response.body?.cancel().catch(() => {});
}
async function commercialSignedDownload(storagePath: string, expiresIn: number) {
  const { url, serviceKey, bucket } = commercialConfig();
  const path = `/storage/v1/object/sign/${encodeURIComponent(bucket)}/${objectPath(storagePath)}`;
  const response = await storageFetch(`${url}${path}`, serviceKey, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn }) });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("Storage download unavailable"); }
  const body = await boundedJson(response);
  return signedUrl(body.signedURL ?? body.signedUrl, url, path).href;
}
