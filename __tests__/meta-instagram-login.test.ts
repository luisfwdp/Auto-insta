import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INSTAGRAM_LOGIN_SCOPES,
  getAuthorizationUrl,
} from "@/lib/meta/oauth";

describe("Instagram Login mode", () => {
  beforeEach(() => {
    vi.stubEnv("INSTAGRAM_LOGIN_MODE", "legacy");
    vi.stubEnv("INSTAGRAM_APP_ID", "app_123");
  });

  it("requests the permission enforced by the publishing worker", () => {
    const url = new URL(
      getAuthorizationUrl("https://example.com/api/instagram/callback", "state")
    );
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("scope")?.split(",")).toEqual(
      DEFAULT_INSTAGRAM_LOGIN_SCOPES
    );
    expect(url.searchParams.get("scope")).toContain(
      "instagram_business_content_publish"
    );
  });
});
