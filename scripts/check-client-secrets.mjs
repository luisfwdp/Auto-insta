import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".next");
const names = ["NEXTAUTH_SECRET", "AUTH_SECRET", "ENCRYPTION_KEY", "DATABASE_URL", "REDIS_URL",
  "ASAAS_API_KEY", "ASAAS_WEBHOOK_TOKEN", "RESEND_API_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "FACEBOOK_APP_SECRET", "INSTAGRAM_APP_SECRET", "WEBHOOK_VERIFY_TOKEN", "CRON_SECRET"];
const secrets = names.flatMap(name => {
  const value = process.env[name];
  return value && value.length >= 16 ? [{ name, variants: [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)] }] : [];
});
function scan(directory, publicOnly = false) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(file, publicOnly);
    else if (entry.isFile() && (!publicOnly || /\.(html|rsc|body)$/.test(file))) {
      const bytes = readFileSync(file);
      for (const { name, variants } of secrets) {
        if (variants.some(value => bytes.includes(Buffer.from(value)))) {
          // Report only the variable name/path, NEVER its value or a snippet.
          throw new Error(`Backend-only configuration found in public output: ${name} (${path.relative(root, file)})`);
        }
      }
    }
  }
}
if (!existsSync(path.join(root, "static"))) throw new Error("Build output missing; run Next build before the privacy check");
scan(path.join(root, "static"));
scan(path.join(root, "server/app"), true);
console.log(`Client privacy check passed (${secrets.length} configured backend values checked).`);
