import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";
import { readBoundedJson } from "../../lib/billing/asaas-client";
import { getBillingProviderScope } from "../../lib/billing/config";

const pulsoOrigin = "https://pulso-central-de-cobrancas.vercel.app";
const excludedProjects = new Set(["qgojitqdpyzprapqazvi", "zivlgtcayiqjsujdcbuo", "gvyzobphrgcjyehmvoyj"]);
const branchRef = /^[a-z0-9]{20}$/;
const poolerHost = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const settings = z.object({
  DATABASE_URL: z.string().min(1),
  PING_CHAT_SANDBOX_DATABASE_REF: z.string().min(1),
  ASAAS_ENVIRONMENT: z.literal("sandbox"),
  ASAAS_ACCOUNT_SCOPE: z.uuid(),
  PULSO_CHECKOUT_ENABLED: z.literal("true"),
  PULSO_CHECKOUT_ENVIRONMENT: z.literal("sandbox"),
  PULSO_CHECKOUT_ORIGIN: z.literal(pulsoOrigin),
  PULSO_APP_TOKEN: z.string().regex(/^pulso_[A-Za-z0-9_-]{43}$/),
  PULSO_PROTECTION_BYPASS: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
});

export function sandboxWorkerConfig(source: Record<string, string | undefined>) {
  const config = settings.parse(source);
  const url = new URL(config.DATABASE_URL);
  const ref = config.PING_CHAT_SANDBOX_DATABASE_REF;
  const validOptions = [...url.searchParams].every(([key]) => key === "sslmode") && url.searchParams.size <= 1;
  if (!["postgresql:", "postgres:"].includes(url.protocol) || url.hash || !url.username || !validOptions) {
    throw new Error("SANDBOX_DATABASE_REQUIRED");
  }

  const local = ref === "loopback" && ["127.0.0.1", "[::1]"].includes(url.hostname)
    && url.pathname === "/ping_chat_pulso_sandbox";
  const direct = url.hostname === `db.${ref}.supabase.co` && url.username === "postgres";
  const pooled = poolerHost.test(url.hostname) && url.username === `postgres.${ref}`;
  const hosted = branchRef.test(ref) && !excludedProjects.has(ref) && (direct || pooled)
    && url.pathname === "/postgres" && (!url.port || url.port === "5432")
    && ["require", "verify-full"].includes(url.searchParams.get("sslmode") ?? "");
  if (!local && !hosted) throw new Error("SANDBOX_DATABASE_REQUIRED");
  return config;
}

export async function verifyPulsoSandbox(config: ReturnType<typeof sandboxWorkerConfig>, fetcher = fetch) {
  const query = new URLSearchParams({ orderId: randomUUID(), limit: "1" });
  const response = await fetcher(`${pulsoOrigin}/api/charges?${query}`, {
    method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(3500),
    headers: { Authorization: `Bearer ${config.PULSO_APP_TOKEN}`, "x-pulso-environment": "sandbox",
      "x-vercel-protection-bypass": config.PULSO_PROTECTION_BYPASS },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error("PULSO_SANDBOX_UNAVAILABLE");
  }
  z.object({ app: z.literal("ping-chat"), data: z.tuple([]), nextOffset: z.null() }).parse(await readBoundedJson(response));
}

function localConfig() {
  const file = openSync(".env.pulso-sandbox.local", constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new Error("PRIVATE_CONFIGURATION_REQUIRED");
    return sandboxWorkerConfig(parseEnv(readFileSync(file, "utf8")));
  } finally { closeSync(file); }
}

async function main() {
  const [mode = "--check", ...rest] = process.argv.slice(2);
  if (!["--check", "--once"].includes(mode) || rest.length || process.env.VERCEL || process.env.VERCEL_ENV || process.env.FLY_APP_NAME) {
    throw new Error("LOCAL_SANDBOX_COMMAND_REQUIRED");
  }
  const config = localConfig();
  const scope = getBillingProviderScope(config);
  await verifyPulsoSandbox(config);

  Object.assign(process.env, config);
  delete process.env.ASAAS_API_KEY;
  const { getPrisma } = await import("../../lib/db/client");
  const db = getPrisma();
  try {
    const records = await db.billingEvent.count({ where: scope });
    const result = { success: true, environment: "sandbox", pulso: true, database: true, existingEvents: records };
    if (mode === "--check") {
      console.log(JSON.stringify(result));
      return;
    }
    const { runBillingMaintenanceOnce } = await import("../../lib/billing/worker");
    console.log(JSON.stringify({ ...result, ...await runBillingMaintenanceOnce() }));
  } finally { await db.$disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error(JSON.stringify({ success: false, code: "PULSO_SANDBOX_WORKER_FAILED" }));
    process.exitCode = 1;
  });
}
