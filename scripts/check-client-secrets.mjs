import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import nextEnv from "@next/env";

const root = path.resolve(process.argv[2] ?? ".next");
const names = ["NEXTAUTH_SECRET", "AUTH_SECRET", "ENCRYPTION_KEY", "DATABASE_URL", "REDIS_URL",
  "ASAAS_API_KEY", "ASAAS_WEBHOOK_TOKEN", "RESEND_API_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "FACEBOOK_APP_SECRET", "INSTAGRAM_APP_SECRET", "WEBHOOK_VERIFY_TOKEN", "CRON_SECRET",
  "PULSO_APP_TOKEN", "PULSO_WEBHOOK_SECRET", "PULSO_PROTECTION_BYPASS", "BATIDA_AFFILIATE_CHECKOUT_SECRET"];

nextEnv.loadEnvConfig(process.cwd(), false, {
  info() {},
  error() { throw new Error("Unable to load build configuration."); },
});
for (const name of names) {
  const publicName = "NEXT_PUBLIC_" + name;
  if (Object.hasOwn(process.env, publicName)) {
    throw new Error(`Backend-only configuration uses a public prefix: ${publicName}`);
  }
}
const secrets = names.flatMap(name => {
  const value = process.env[name];
  return value && value.length >= 16 ? [{ name, variants: [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)] }] : [];
});
function scan(directory, publicOnly = false) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(file, publicOnly);
    else if (entry.isFile() && (!publicOnly || /\.(html|rsc|body|meta)$/.test(file))) {
      const bytes = readFileSync(file);
      for (const { name, variants } of secrets) {
        if (variants.some(value => bytes.includes(Buffer.from(value)))) {
          // A filename may also contain a secret. Report only the variable name.
          throw new Error(`Backend-only configuration found in public output: ${name}`);
        }
      }
    }
  }
}
if (!existsSync(path.join(root, "static"))) throw new Error("Build output missing; run Next build before the privacy check");
scan(path.join(root, "static"));
scan(path.resolve("public"));
scan(path.join(root, "server/app"), true);
console.log(`Client privacy check passed (${secrets.length} configured backend values checked).`);
