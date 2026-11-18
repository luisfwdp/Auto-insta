import { describe, expect, it } from "vitest";
import { sanitizeAnalyticsEvent } from "@/lib/analytics/privacy";

describe("analytics URL privacy", () => {
  it.each(["pageview", "event"] as const)("removes query and fragment from %s without mutating the input", (type) => {
    const event = Object.freeze({ type, url: "https://example.test/scheduling?token=FAKE_QUERY&email=fake%40example.test#FAKE_FRAGMENT" });
    expect(sanitizeAnalyticsEvent(event)).toEqual({ type, url: "https://example.test/scheduling" });
    expect(event.url).toContain("FAKE_QUERY");
  });
  it.each(["/invite/FAKE_INVITE", "/invite?token=FAKE_INVITE", "/%69nvite/FAKE_INVITE"])("drops invitation page views and custom events for %s", (path) => {
    for (const type of ["pageview", "event"] as const) expect(sanitizeAnalyticsEvent({ type, url: `https://example.test${path}` })).toBeNull();
  });
  it.each(["invalid url", "data:text/plain,FAKE", "https://fake-user:fake-pass@example.test/scheduling"])("drops unsafe or malformed URL %s", (url) => {
    expect(sanitizeAnalyticsEvent({ type: "pageview", url })).toBeNull();
  });
});
