import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { rejectUnauthorizedCron } from "@/lib/api/cron-auth";
import { httpUrl } from "@/lib/api/http-url";

const saved = { CRON_SECRET: process.env.CRON_SECRET, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function cronRequest(authorization?: string) {
  return new NextRequest("https://app.example/api/cron/refresh-tokens", {
    headers: authorization ? { authorization } : {},
  });
}

describe("rejectUnauthorizedCron", () => {
  it("lets Vercel's scheduled call through with the configured secret", () => {
    process.env.CRON_SECRET = "cron-secret-value";
    expect(rejectUnauthorizedCron(cronRequest("Bearer cron-secret-value"))).toBeNull();
  });

  it("refuses a wrong, missing or differently sized bearer", () => {
    process.env.CRON_SECRET = "cron-secret-value";
    expect(rejectUnauthorizedCron(cronRequest("Bearer nope"))?.status).toBe(401);
    expect(rejectUnauthorizedCron(cronRequest())?.status).toBe(401);
    expect(rejectUnauthorizedCron(cronRequest("Bearer cron-secret-valuX"))?.status).toBe(401);
  });

  it("no longer accepts the session secret as a cron bearer", () => {
    delete process.env.CRON_SECRET;
    process.env.NEXTAUTH_SECRET = "session-secret";
    expect(rejectUnauthorizedCron(cronRequest("Bearer session-secret"))?.status).toBe(503);
  });

  it("fails closed when no secret is configured, even for 'Bearer undefined'", () => {
    delete process.env.CRON_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    expect(rejectUnauthorizedCron(cronRequest("Bearer undefined"))?.status).toBe(503);
  });
});

describe("httpUrl", () => {
  it("accepts http and https destinations", () => {
    expect(httpUrl.safeParse("https://criaping.example/oferta?utm=ig").success).toBe(true);
    expect(httpUrl.safeParse("http://loja.example").success).toBe(true);
  });

  it("rejects schemes a DM button or report link must never open", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "mailto:someone@example.com",
      "ftp://example.com/file",
      "not a url",
    ]) {
      expect(httpUrl.safeParse(value).success, value).toBe(false);
    }
  });

  it("caps the length", () => {
    expect(httpUrl.safeParse(`https://example.com/${"a".repeat(2100)}`).success).toBe(false);
  });
});
