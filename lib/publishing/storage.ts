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

export async function createSignedUpload(storagePath: string) {
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

export async function inspectPrivateObject(storagePath: string) {
  const { url, serviceKey, bucket } = config();
  const response = await fetch(`${url}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${objectPath(storagePath)}`, {
    headers: { ...headers(serviceKey), Range: "bytes=0-31" },
  });
  if (!response.ok) return null;
  const contentRange = response.headers.get("content-range");
  const rangeSize = contentRange?.match(/\/(\d+)$/)?.[1];
  const byteSize = Number(rangeSize ?? response.headers.get("content-length"));
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) return null;
  const reader = response.body?.getReader();
  const first = await reader?.read();
  await reader?.cancel();
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

export async function deletePrivateObject(storagePath: string) {
  const { url, serviceKey, bucket } = config();
  const response = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}`, {
    method: "DELETE",
    headers: headers(serviceKey, "application/json"),
    body: JSON.stringify({ prefixes: [storagePath] }),
  });
  if (!response.ok && response.status !== 404) throw new Error(`Storage rejected deletion (${response.status})`);
}
