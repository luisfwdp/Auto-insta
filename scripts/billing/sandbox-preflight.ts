/** Read-only Sandbox check. Never creates a customer, checkout or payment. */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { AsaasError, createAsaasClient } from "../../lib/billing/asaas-client";

async function main() {
  const filename = resolve(".env.asaas-sandbox.local");
  if ((statSync(filename).mode & 0o077) !== 0) throw new Error("PRIVATE_CONFIGURATION_REQUIRED");
  const config = parseEnv(readFileSync(filename, "utf8"));
  // Only these allowlisted fields are used. DATABASE_URL/NODE_OPTIONS are never loaded.
  if (config.ASAAS_ENVIRONMENT !== "sandbox") throw new Error("SANDBOX_REQUIRED");
  const client = createAsaasClient({ ASAAS_ENVIRONMENT: "sandbox", ASAAS_API_KEY: config.ASAAS_API_KEY,
    NEXTAUTH_URL: config.NEXTAUTH_URL ?? "http://localhost:3164" });
  // A fresh unguessable ID tests auth + the documented filter without returning
  // existing payer records. A nonempty response is not printed or accepted.
  const result = await client.listPaymentsByCheckout(randomUUID(), { limit: 1 });
  if (result.data.length || result.totalCount !== 0 || result.hasMore) throw new Error("UNEXPECTED_SANDBOX_RESPONSE");
  console.log(JSON.stringify({ success: true, environment: "sandbox", authenticated: true, checkoutFilter: true, financialMutations: 0 }));
}

void main().catch(error => {
  const known = error instanceof AsaasError ? error.code : "SANDBOX_PREFLIGHT_FAILED";
  console.error(JSON.stringify({ success: false, code: known }));
  process.exitCode = 1;
});
