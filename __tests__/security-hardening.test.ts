vi.mock("@/lib/api/request-rate-limit", () => ({ requestLimitResponse: vi.fn(async () => null) }));
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { proxy } from "../proxy";
import {
  AUTH_RATE_LIMITS,
  checkMagicLinkRateLimit,
} from "../lib/api/auth-rate-limit";

const savedSecret = process.env.NEXTAUTH_SECRET;

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = "test-secret-with-enough-entropy";
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = savedSecret;
});

function fakeRedis() {
  const counts = new Map<string, number>();
  return {
    eval: async (_script: string, _keys: number, key: string) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return [count, AUTH_RATE_LIMITS.windowSeconds];
    },
  };
}

describe("magic-link brute-force protection", () => {
  it("limits an account even when requests come from different IPs", async () => {
    const redis = fakeRedis();
    for (let attempt = 1; attempt <= AUTH_RATE_LIMITS.account; attempt += 1) {
      await expect(
        checkMagicLinkRateLimit({
          headers: new Headers({ "x-forwarded-for": `203.0.113.${attempt}` }),
          email: "Person@Example.com",
          redis: redis as never,
        })
      ).resolves.toEqual({ allowed: true });
    }
    await expect(
      checkMagicLinkRateLimit({
        headers: new Headers({ "x-forwarded-for": "203.0.113.99" }),
        email: "person@example.com",
        redis: redis as never,
      })
    ).resolves.toMatchObject({ allowed: false });
  });

  it("limits an IP even when it rotates account identifiers", async () => {
    const redis = fakeRedis();
    for (let attempt = 1; attempt <= AUTH_RATE_LIMITS.ip; attempt += 1) {
      await checkMagicLinkRateLimit({
        headers: new Headers({ "x-forwarded-for": "203.0.113.10" }),
        email: `person-${attempt}@example.com`,
        redis: redis as never,
      });
    }
    await expect(
      checkMagicLinkRateLimit({
        headers: new Headers({ "x-forwarded-for": "203.0.113.10" }),
        email: "another@example.com",
        redis: redis as never,
      })
    ).resolves.toMatchObject({ allowed: false });
  });

  it.each([null, ["not-an-integer", 900], [1, -1], [1, 901], [1, null]])(
    "blocks magic-link admission after an invalid Redis answer: %j", async invalid => {
      const redis = { eval: vi.fn().mockResolvedValueOnce([1, 900]).mockResolvedValueOnce(invalid) };
      await expect(checkMagicLinkRateLimit({ headers: new Headers(), email: "person@example.test", redis: redis as never }))
        .rejects.toThrow("Rate limit store unavailable");
    }
  );
});

describe("browser origin allowlist", () => {
  it("rejects cross-origin API writes without reflecting the Origin", async () => {
    const response = await proxy(
      new NextRequest("https://app.example/api/automations", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      })
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows same-origin API writes", async () => {
    const response = await proxy(
      new NextRequest("https://app.example/api/automations", {
        method: "POST",
        headers: { origin: "https://app.example" },
      })
    );
    expect(response.status).toBe(200);
  });

  it("rejects cookie-authenticated writes that omit Origin", async () => {
    const response = await proxy(
      new NextRequest("https://app.example/api/automations", {
        method: "POST",
        headers: { cookie: "__Secure-authjs.session-token=browser-session" },
      })
    );
    expect(response.status).toBe(403);
  });

  it("allows server-to-server writes without Origin or a session cookie", async () => {
    const response = await proxy(
      new NextRequest("https://app.example/api/webhook", {
        method: "POST",
      })
    );
    expect(response.status).toBe(200);
  });
});

describe("response hardening", () => {
  it("sets anti-clickjacking and browser security headers globally", async () => {
    const rules = await nextConfig.headers!();
    const headers = new Map(rules[0].headers.map((header) => [header.key, header.value]));
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Strict-Transport-Security")).toContain("includeSubDomains");
  });

  it("does not serialize raw invitation tokens", async () => {
    const source = await readFile("app/api/workspace/members/route.ts", "utf8");
    expect(source).not.toContain("...invitation");
    expect(source).not.toMatch(/token:\s*invitation\.token/);
  });
});
