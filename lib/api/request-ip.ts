import "server-only";
import { isIP } from "node:net";

/** Only deployment configuration can opt into trusting a reverse proxy.
 * Vercel overwrites forwarding headers; arbitrary self-hosted clients do not.
 * https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for */
export function requestIp(headers: Headers): string {
  if (process.env.VERCEL !== "1" && process.env.TRUST_PROXY_HEADERS !== "true") return "unknown";
  const source = process.env.VERCEL === "1" ? headers.get("x-vercel-forwarded-for") ?? headers.get("x-forwarded-for")
    : headers.get("x-forwarded-for");
  const ip = source?.split(",", 1)[0].trim();
  if (!ip || !isIP(ip)) return "unknown";
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}
