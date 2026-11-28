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
  if (!ip || ip.includes("%")) return "unknown";
  const family = isIP(ip);
  if (family === 6) return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  return family === 4 ? ip : "unknown";
}

/** Share one budget across IPv6 addresses on a /64. Preserve IPv4 subjects. */
export function requestRateOrigin(headers: Headers): string {
  const ip = requestIp(headers);
  if (!ip.includes(":")) return ip;

  const [head, tail] = ip.split("::");
  const leading = head ? head.split(":") : [];
  const trailing = tail ? tail.split(":") : [];
  const groups = tail === undefined ? leading
    : [...leading, ...Array<string>(8 - leading.length - trailing.length).fill("0"), ...trailing];

  if (groups.slice(0, 5).every(group => group === "0") && groups[5] === "ffff") {
    const high = parseInt(groups[6], 16);
    const low = parseInt(groups[7], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}
