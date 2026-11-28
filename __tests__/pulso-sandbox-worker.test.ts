import { describe, expect, it, vi } from "vitest";
import { sandboxWorkerConfig, verifyPulsoSandbox } from "../scripts/billing/pulso-sandbox-worker";

const origin = "https://pulso-central-de-cobrancas.vercel.app";
const branch = "aaaaaaaaaaaaaaaaaaaa";
const fixture = {
  DATABASE_URL: "postgresql://postgres:fixture@127.0.0.1:5432/ping_chat_pulso_sandbox",
  PING_CHAT_SANDBOX_DATABASE_REF: "loopback",
  ASAAS_ENVIRONMENT: "sandbox",
  ASAAS_ACCOUNT_SCOPE: "10000000-0000-4000-8000-000000000001",
  PULSO_CHECKOUT_ENABLED: "true",
  PULSO_CHECKOUT_ENVIRONMENT: "sandbox",
  PULSO_CHECKOUT_ORIGIN: origin,
  PULSO_APP_TOKEN: `pulso_${"a".repeat(43)}`,
  PULSO_PROTECTION_BYPASS: "test-protection-secret",
};

describe("Pulso Sandbox worker", () => {
  it("uses only allowlisted settings for a disposable local database", () => {
    expect(sandboxWorkerConfig({ ...fixture, ASAAS_API_KEY: "test-never-load-this", NODE_OPTIONS: "--inspect" })).toEqual(fixture);
  });

  it.each([
    `postgresql://postgres:fixture@db.${branch}.supabase.co:5432/postgres?sslmode=verify-full`,
    `postgresql://postgres.${branch}:fixture@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require`,
  ])("permits a matching isolated Supabase database", DATABASE_URL => {
    expect(sandboxWorkerConfig({ ...fixture, DATABASE_URL, PING_CHAT_SANDBOX_DATABASE_REF: branch }).DATABASE_URL).toBe(DATABASE_URL);
  });

  it.each([
    { ASAAS_ENVIRONMENT: "production" },
    { PULSO_CHECKOUT_ENVIRONMENT: "production" },
    { PULSO_CHECKOUT_ORIGIN: "https://pulsofinance.app" },
    { PULSO_PROTECTION_BYPASS: "" },
    { DATABASE_URL: "postgresql://postgres:fixture@127.0.0.1:5432/postgres" },
    { DATABASE_URL: "postgresql://postgres:fixture@127.0.0.1/ping_chat_pulso_sandbox?host=example.test" },
    { DATABASE_URL: `postgresql://postgres.${branch}:fixture@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
      PING_CHAT_SANDBOX_DATABASE_REF: branch },
    { DATABASE_URL: `postgresql://postgres:fixture@db.${branch}.supabase.co/postgres`, PING_CHAT_SANDBOX_DATABASE_REF: branch },
    { DATABASE_URL: `postgresql://postgres:fixture@db.${branch}.supabase.co/postgres?sslmode=require`, PING_CHAT_SANDBOX_DATABASE_REF: "bbbbbbbbbbbbbbbbbbbb" },
    ...["qgojitqdpyzprapqazvi", "zivlgtcayiqjsujdcbuo", "gvyzobphrgcjyehmvoyj"].map(ref =>
      ({ DATABASE_URL: `postgresql://postgres.${ref}:fixture@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require`, PING_CHAT_SANDBOX_DATABASE_REF: ref })),
  ])("rejects a configuration outside the dedicated Sandbox", invalid => {
    expect(() => sandboxWorkerConfig({ ...fixture, ...invalid })).toThrow();
  });

  it("checks an unused order using only the protected Pulso Sandbox origin", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ app: "ping-chat", data: [], nextOffset: null }));
    await expect(verifyPulsoSandbox(sandboxWorkerConfig(fixture), fetcher)).resolves.toBeUndefined();
    const [[address, request]] = fetcher.mock.calls;
    const url = new URL(String(address));
    expect([url.origin, url.pathname]).toEqual([origin, "/api/charges"]);
    expect(url.searchParams.get("orderId")).toMatch(/^[a-f0-9-]{36}$/);
    expect(request).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", headers: {
      Authorization: `Bearer ${fixture.PULSO_APP_TOKEN}`, "x-pulso-environment": "sandbox",
      "x-vercel-protection-bypass": fixture.PULSO_PROTECTION_BYPASS,
    } });
  });

  it.each([
    [401, { error: "not_authorized" }],
    [200, { app: "other-app", data: [], nextOffset: null }],
    [200, { app: "ping-chat", data: [{ id: "unexpected" }], nextOffset: null }],
  ])("rejects a response that does not prove the expected sandbox registration", async (status, payload) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload, { status }));
    await expect(verifyPulsoSandbox(sandboxWorkerConfig(fixture), fetcher)).rejects.toThrow();
  });
});
