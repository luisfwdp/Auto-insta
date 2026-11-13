import { getMetaGraphApiVersion, requireEnv } from "@/lib/env";

/**
 * Instagram API with Facebook Login (classic, scope-based dialog).
 *
 * Unlike Facebook Login for Business, the permissions come from the `scope`
 * parameter, not from a login configuration. The user token is exchanged for a
 * long-lived one, the Instagram professional account is read from the Page it
 * is linked to, and the Page access token (which does not expire when derived
 * from a long-lived user token) is what the app stores and uses.
 *
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started
 * https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 * https://developers.facebook.com/docs/graph-api/reference/user/accounts/
 */
export const DEFAULT_FACEBOOK_LOGIN_SCOPES = [
  "instagram_basic",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "instagram_content_publish",
  "instagram_manage_contents",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "business_management",
];

export function getFacebookLoginScopes(): string {
  const configured = process.env.INSTAGRAM_FACEBOOK_SCOPES?.trim();
  return configured || DEFAULT_FACEBOOK_LOGIN_SCOPES.join(",");
}

function graphBase() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

async function graphJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url.toString(), { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) {
    // Meta's message, never the request URL (it carries the token).
    throw new Error(body?.error?.message ?? `Graph API error ${response.status}`);
  }
  return body as T;
}

export async function exchangeForLongLivedUserToken(userToken: string): Promise<string> {
  const url = new URL(`${graphBase()}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", requireEnv("INSTAGRAM_APP_ID"));
  url.searchParams.set("client_secret", requireEnv("INSTAGRAM_APP_SECRET"));
  url.searchParams.set("fb_exchange_token", userToken);
  const data = await graphJson<{ access_token: string }>(url);
  return data.access_token;
}

export interface PageInstagramAccount {
  pageId: string;
  pageName?: string;
  pageAccessToken: string;
  instagramId: string;
  username?: string;
}

/** Every Page the user granted that has an Instagram professional account linked. */
export async function resolvePageInstagramAccounts(
  userToken: string
): Promise<{ accounts: PageInstagramAccount[]; pageCount: number }> {
  const url = new URL(`${graphBase()}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username}");
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", userToken);
  const data = await graphJson<{
    data: Array<{
      id: string;
      name?: string;
      access_token?: string;
      instagram_business_account?: { id: string; username?: string };
    }>;
  }>(url);
  const accounts = data.data
    .filter((page) => page.instagram_business_account?.id && page.access_token)
    .map((page) => ({
      pageId: page.id,
      pageName: page.name,
      pageAccessToken: page.access_token as string,
      instagramId: page.instagram_business_account!.id,
      username: page.instagram_business_account!.username,
    }));
  return { accounts, pageCount: data.data.length };
}

/** Granted permission names, for non-secret diagnostics. */
export async function getGrantedPermissions(userToken: string): Promise<string[]> {
  try {
    const url = new URL(`${graphBase()}/me/permissions`);
    url.searchParams.set("access_token", userToken);
    const data = await graphJson<{ data: Array<{ permission: string; status: string }> }>(url);
    return data.data.filter((p) => p.status === "granted").map((p) => p.permission);
  } catch {
    return [];
  }
}

/**
 * Installs the app on the Page so Instagram comment and message webhooks are
 * delivered (requires pages_manage_metadata).
 * https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/
 */
export async function subscribePageToWebhooks(
  pageId: string,
  pageAccessToken: string
): Promise<{ success: boolean }> {
  const url = new URL(`${graphBase()}/${pageId}/subscribed_apps`);
  url.searchParams.set("subscribed_fields", "feed,messages");
  url.searchParams.set("access_token", pageAccessToken);
  return graphJson<{ success: boolean }>(url, { method: "POST" });
}
