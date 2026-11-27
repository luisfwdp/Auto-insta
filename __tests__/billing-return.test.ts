import { describe, expect, it } from "vitest";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import nextConfig from "../next.config";

describe("hosted checkout return route", () => {
  it.each(["success", "canceled", "expired"])("preserves the checkout reference on %s", async (result) => {
    const origin = "https://www.pingchatbr.app";
    const checkout = "10000000-0000-4000-8000-000000000001";
    const response = await unstable_getResponseFromNextConfig({
      url: `${origin}/settings/billing?checkout=${checkout}&result=${result}`,
      nextConfig,
    });
    expect(response.status).toBe(307);
    const destination = new URL(response.headers.get("location")!, origin);
    expect(destination.origin).toBe(origin);
    expect(destination.pathname).toBe("/billing");
    expect(Object.fromEntries(destination.searchParams)).toEqual({ checkout, result });
  });
});
