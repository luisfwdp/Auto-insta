import { afterEach, expect, it, vi } from "vitest";
import { GET } from "../app/api/billing/offer/[reference]/route";
import { readPulsoOfferReference } from "../lib/billing/pulso-offer";

const reference = "c618b6e7-1774-4c6d-b0b1-4ea74723e935";
const landing = (query: string, value = reference) => GET(new Request(`https://www.pingchatbr.app/api/billing/offer/${value}${query}`),
  { params: Promise.resolve({ reference: value }) });
afterEach(() => vi.unstubAllEnvs());

it("strips the offer reference from the redirect and keeps it in a private cookie for its plan", async () => {
  vi.stubEnv("PULSO_CHECKOUT_ENABLED", "true");
  const response = await landing("?plan=pro-v1");
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/pricing?plan=pro-v1#plan-pro-v1");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("set-cookie")).toContain(`pulso-offer-pro-v1=${reference}`);
  for (const flag of ["HttpOnly", "Secure", "SameSite=lax", "Path=/api/billing/checkout", "Max-Age=5400"]) {
    expect(response.headers.get("set-cookie")).toContain(flag);
  }
});

it.each([
  ["?plan=pro-v1", "malformed"], ["?plan=other", reference],
  ["?plan=pro-v1&plan=agency-v1", reference], ["?plan=pro-v1&next=https://outside.test", reference],
])("rejects malformed or ambiguous offer links without a cookie", async (query, value) => {
  const response = await landing(query, value);
  expect(response.status).toBe(404);
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("does not capture a reference when direct checkout through Pulso is inactive", async () => {
  vi.stubEnv("PULSO_CHECKOUT_ENABLED", "false");
  expect((await landing("?plan=pro-v1")).headers.get("set-cookie")).toBeNull();
});

it("uses a well-formed, unique cookie for the buyer's chosen plan only", () => {
  vi.stubEnv("PULSO_CHECKOUT_ENABLED", "true");
  const cookie = `pulso-offer-pro-v1=${reference}`;
  const request = (value: string) => new Request("https://www.pingchatbr.app/api/billing/checkout", { headers: { cookie: value } });
  expect(readPulsoOfferReference(request(cookie), "pro-v1")).toBe(reference);
  expect(readPulsoOfferReference(request(cookie), "agency-v1")).toBeUndefined();
  expect(readPulsoOfferReference(request(`${cookie}; ${cookie}`), "pro-v1")).toBeUndefined();
  expect(readPulsoOfferReference(request("pulso-offer-pro-v1=invalid"), "pro-v1")).toBeUndefined();
});
