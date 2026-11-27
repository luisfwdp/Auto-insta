import type { BeforeSendEvent } from "@vercel/analytics";

/** Never send invitation credentials, URL query parameters or fragments. */
export function sanitizeAnalyticsEvent(event: BeforeSendEvent): BeforeSendEvent | null {
  try {
    const url = new URL(event.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (["/invite", "/material"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return null;
    url.search = "";
    url.hash = "";
    return { ...event, url: url.toString() };
  } catch {
    return null;
  }
}
