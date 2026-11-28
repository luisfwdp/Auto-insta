vi.mock("@/lib/api/request-rate-limit", () => ({ requestLimitResponse: vi.fn(async () => null) }));
/**
 * Sign-in flow guarantees the first production login relies on: the allowlist
 * decides who gets a magic link, new users get a workspace, magic links and
 * redirects are pinned to NEXTAUTH_URL, and every dashboard page is behind the
 * login redirect. No database or mail provider is touched.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActionURL } from "@auth/core";

const ensureWorkspaceForUser = vi.fn();

// next-auth itself does not load under Vitest (see workspace-isolation.db.test.ts);
// the config object under test is plain data and callbacks, so it is enough to
// stub the factory and the adapter around it.
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: async () => null, signIn: async () => undefined, signOut: async () => undefined }),
}));
vi.mock("next-auth/providers/resend", () => ({ default: (options: object) => ({ id: "resend", ...options }) }));
vi.mock("next-auth/providers/nodemailer", () => ({ default: (options: object) => ({ id: "nodemailer", ...options }) }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/workspace", () => ({
  ensureWorkspaceForUser: (...args: unknown[]) => ensureWorkspaceForUser(...args),
  getPrimaryWorkspace: vi.fn(),
}));

const ENV_KEYS = ["ALLOWED_EMAILS", "ALLOWED_EMAILS_REQUIRED", "NEXTAUTH_URL", "AUTH_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  ensureWorkspaceForUser.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function loadAuthConfig() {
  const { authConfig } = await import("@/lib/auth");
  return authConfig;
}

describe("signIn callback (allowlist)", () => {
  it("lets the allowlisted admin in, case-insensitively", async () => {
    process.env.ALLOWED_EMAILS = "luisfwdp@gmail.com";
    process.env.ALLOWED_EMAILS_REQUIRED = "true";
    const { callbacks } = await loadAuthConfig();
    const allowed = await callbacks.signIn({ user: { email: "LuisFWDP@gmail.com" } } as never);
    expect(allowed).toBe(true);
  });

  it("refuses anyone else, so no magic link is sent to them", async () => {
    process.env.ALLOWED_EMAILS = "luisfwdp@gmail.com";
    process.env.ALLOWED_EMAILS_REQUIRED = "true";
    const { callbacks } = await loadAuthConfig();
    expect(await callbacks.signIn({ user: { email: "intruder@example.com" } } as never)).toBe(false);
    expect(await callbacks.signIn({ user: {} } as never)).toBe(false);
  });

  it("locks everyone out when the allowlist is required but empty", async () => {
    process.env.ALLOWED_EMAILS = "";
    process.env.ALLOWED_EMAILS_REQUIRED = "true";
    const { callbacks } = await loadAuthConfig();
    expect(await callbacks.signIn({ user: { email: "luisfwdp@gmail.com" } } as never)).toBe(false);
  });
});

describe("createUser event", () => {
  it("creates the new user's workspace", async () => {
    const { events } = await loadAuthConfig();
    await events.createUser({ user: { id: "user_1", email: "luisfwdp@gmail.com" } } as never);
    expect(ensureWorkspaceForUser).toHaveBeenCalledWith("user_1", "luisfwdp@gmail.com");
  });
});

describe("session configuration", () => {
  it("uses database sessions and the CRIA PING pages", async () => {
    const config = await loadAuthConfig();
    expect(config.session.strategy).toBe("database");
    expect(config.pages).toEqual({ signIn: "/login", verifyRequest: "/verify-request" });
  });

  it("exposes only public session fields, never database bearer or adapter fields", async () => {
    const { callbacks } = await loadAuthConfig();
    const expires = new Date("2030-01-01T00:00:00.000Z");
    const user = { id: "user_1", name: "Local", email: "local@example.test", image: null, createdAt: new Date(), internalField: "private-user-field" };
    const session = { id: "session_1", sessionToken: "fake-test-bearer", userId: user.id, expires, user, internalField: "private-session-field" };
    const result = await callbacks.session({ session, user } as never);
    expect(result).toEqual({ expires: expires.toISOString(), user: { id: user.id, name: user.name, email: user.email, image: null } });
    expect(JSON.stringify(result)).not.toContain("fake-test-bearer");
    expect(session.sessionToken).toBe("fake-test-bearer");
    expect(user.internalField).toBe("private-user-field");
  });

  it("preserves the user id for server guards and normalizes nullable public fields", async () => {
    const { callbacks } = await loadAuthConfig();
    const result = await callbacks.session({ session: { expires: "2030-01-01T00:00:00.000Z" }, user: { id: "user_2" } } as never);
    expect(result).toEqual({ expires: "2030-01-01T00:00:00.000Z", user: { id: "user_2", name: null, email: null, image: null } });
  });

  it("does not override the default redirect callback, which only allows same-origin targets", async () => {
    const { callbacks } = await loadAuthConfig();
    expect("redirect" in callbacks).toBe(false);
  });
});

describe("magic link origin", () => {
  it("builds auth URLs from NEXTAUTH_URL, not from a spoofed Host header", () => {
    const headers = new Headers({ host: "evil.example", "x-forwarded-host": "evil.example" });
    const url = createActionURL(
      "signin",
      "https",
      headers,
      { NEXTAUTH_URL: "https://auto-insta-luisfwdp-2259s-projects.vercel.app" },
      { basePath: "/api/auth" } as never
    );
    expect(url.origin).toBe("https://auto-insta-luisfwdp-2259s-projects.vercel.app");
  });
});

describe("login redirect for dashboard pages", () => {
  const dashboardDir = path.resolve(__dirname, "../app/(dashboard)");
  const pages = readdirSync(dashboardDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/${entry.name}`);

  it("covers every page under app/(dashboard)", async () => {
    const { PROTECTED_PREFIXES, config } = await import("../proxy");
    for (const page of pages) {
      expect(PROTECTED_PREFIXES).toContain(page);
      expect(config.matcher).toContain(`${page}/:path*`);
    }
  });

  it("sends a signed-out visitor to /login with a relative callbackUrl", async () => {
    const { proxy } = await import("../proxy");
    for (const page of pages) {
      const response = await proxy(new NextRequest(`https://app.example${page}/x`));
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("callbackUrl")).toBe(`${page}/x`);
    }
  });

  it("lets a request with a session cookie through", async () => {
    const { proxy } = await import("../proxy");
    const request = new NextRequest("https://app.example/campaigns", {
      headers: { cookie: "__Secure-authjs.session-token=abc" },
    });
    expect((await proxy(request)).headers.get("location")).toBeNull();
  });

  it("lets the sign-in page validate expired or revoked session cookies", async () => {
    const { proxy } = await import("../proxy");
    const request = new NextRequest("https://app.example/login", {
      headers: { cookie: "__Secure-authjs.session-token=stale" },
    });
    expect((await proxy(request)).headers.get("location")).toBeNull();
  });
});
