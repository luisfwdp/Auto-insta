import { getInstagramLoginMode, getMetaGraphApiVersion, usesFacebookGraph } from "@/lib/env";
import { MetaApiError, PermissionError, RateLimitError, TokenExpiredError } from "@/lib/meta/client";

/** Official flow: https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api */
export type PublishMediaInput =
  | { kind: "IMAGE"; url: string }
  | { kind: "REEL"; url: string; shareToFeed?: boolean; trial?: boolean; trialGraduationStrategy?: "MANUAL" | "SS_PERFORMANCE" }
  | { kind: "CAROUSEL"; children: Array<{ kind: "IMAGE" | "VIDEO"; url: string }> };
export interface ContentPublishingLimit { quotaUsage: number; quotaTotal: number; quotaDurationSeconds: number }
export interface PublishResult { containerId: string; mediaId: string }
interface MetaErrorBody { error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string } }
export interface ContainerStatus { id: string; status_code: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED"; status?: string }

function graphBase(): string {
  const host = usesFacebookGraph() ? "graph.facebook.com" : "graph.instagram.com";
  return `https://${host}/${getMetaGraphApiVersion()}`;
}
function safePath(url: string): string {
  try { return new URL(url).pathname; } catch { return "Graph API"; }
}
async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & MetaErrorBody;
  if (response.ok && !body.error) return body;
  const code = body.error?.code ?? response.status;
  const traceId = body.error?.fbtrace_id;
  const message = `${body.error?.message ?? "Unknown Meta API error"} (${safePath(response.url)})`;
  if (code === 190) throw new TokenExpiredError(message, traceId);
  if (code === 4 || code === 17 || code === 368) throw new RateLimitError(message, traceId);
  if (code === 10 || code === 100 || code === 200) throw new PermissionError(message, traceId);
  throw new MetaApiError(code, body.error?.error_subcode, traceId, message);
}
async function graphGet<T>(path: string, accessToken: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${graphBase()}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return parseResponse<T>(await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }));
}
async function graphPost<T>(path: string, accessToken: string, params: Record<string, string>): Promise<T> {
  return parseResponse<T>(await fetch(`${graphBase()}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }));
}

export async function assertContentPublishPermission(accessToken: string): Promise<void> {
  const required = getInstagramLoginMode() === "legacy" ? "instagram_business_content_publish" : "instagram_content_publish";
  const response = await graphGet<{ data: Array<{ permission: string; status: string }> }>("me/permissions", accessToken);
  if (!response.data.some((item) => item.permission === required && item.status === "granted"))
    throw new PermissionError(`The connected account has not granted ${required}`);
}

export async function getContentPublishingLimit(instagramAccountId: string, accessToken: string): Promise<ContentPublishingLimit> {
  // GET /{ig-user-id}/content_publishing_limit: use real-time quota, never a hardcoded allowance.
  const response = await graphGet<{ data: Array<{ quota_usage: number; config: { quota_total: number; quota_duration: number } }> }>(
    `${instagramAccountId}/content_publishing_limit`, accessToken, { fields: "quota_usage,config" }
  );
  const limit = response.data[0];
  if (!limit) throw new MetaApiError(500, undefined, undefined, "Meta returned no publishing limit");
  return { quotaUsage: limit.quota_usage, quotaTotal: limit.config.quota_total, quotaDurationSeconds: limit.config.quota_duration };
}

async function createContainer(instagramAccountId: string, accessToken: string, params: Record<string, string>): Promise<string> {
  return (await graphPost<{ id: string }>(`${instagramAccountId}/media`, accessToken, params)).id;
}
export async function createPublishContainer(instagramAccountId: string, accessToken: string, media: PublishMediaInput, caption: string): Promise<string> {
  if (media.kind === "IMAGE") return createContainer(instagramAccountId, accessToken, { image_url: media.url, caption });
  if (media.kind === "REEL") {
    const params: Record<string, string> = { media_type: "REELS", video_url: media.url, caption, share_to_feed: String(media.shareToFeed ?? true) };
    // Official SDK field: https://github.com/facebook/facebook-php-business-sdk/blob/main/src/FacebookAds/Object/IGUser.php
    // Never fake eligibility: Meta accepts or rejects trial_params for this account.
    if (media.trial) params.trial_params = JSON.stringify({ graduation_strategy: media.trialGraduationStrategy ?? "MANUAL" });
    return createContainer(instagramAccountId, accessToken, params);
  }
  if (media.children.length < 2 || media.children.length > 10) throw new Error("Instagram carousels require between 2 and 10 items");
  const children: string[] = [];
  for (const child of media.children) children.push(await createContainer(instagramAccountId, accessToken, {
    ...(child.kind === "IMAGE" ? { image_url: child.url } : { media_type: "VIDEO", video_url: child.url }),
    is_carousel_item: "true",
  }));
  return createContainer(instagramAccountId, accessToken, { media_type: "CAROUSEL", children: children.join(","), caption });
}

export async function waitForContainer(containerId: string, accessToken: string, options: {
  maxAttempts?: number; intervalMs?: number; sleep?: (milliseconds: number) => Promise<void>;
} = {}): Promise<ContainerStatus> {
  const maxAttempts = options.maxAttempts ?? 30;
  const intervalMs = options.intervalMs ?? 10_000;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const state = await getContainerStatus(containerId, accessToken);
    if (state.status_code === "FINISHED" || state.status_code === "PUBLISHED") return state;
    if (state.status_code === "ERROR" || state.status_code === "EXPIRED")
      throw new MetaApiError(500, undefined, undefined, `Instagram container ${state.status_code.toLowerCase()}: ${state.status ?? "no detail"}`);
    if (attempt + 1 < maxAttempts) await sleep(intervalMs);
  }
  throw new MetaApiError(408, undefined, undefined, "Instagram media processing timed out");
}

export function getContainerStatus(containerId: string, accessToken: string): Promise<ContainerStatus> {
  return graphGet<ContainerStatus>(containerId, accessToken, { fields: "status_code,status" });
}

export async function publishContainer(instagramAccountId: string, accessToken: string, containerId: string): Promise<string> {
  return (await graphPost<{ id: string }>(`${instagramAccountId}/media_publish`, accessToken, { creation_id: containerId })).id;
}
export async function publishInstagramMedia(args: { instagramAccountId: string; accessToken: string; media: PublishMediaInput; caption: string }): Promise<PublishResult> {
  const containerId = await createPublishContainer(args.instagramAccountId, args.accessToken, args.media, args.caption);
  await waitForContainer(containerId, args.accessToken);
  const mediaId = await publishContainer(args.instagramAccountId, args.accessToken, containerId);
  return { containerId, mediaId };
}
