import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const checker = fileURLToPath(new URL("../scripts/check-client-secrets.mjs", import.meta.url));
const value = "synthetic/ping+backend-only=token";

function fixture(run: (write: (relative: string, contents: string) => void, check: () => SpawnSyncReturns<string>) => void) {
  const cwd = mkdtempSync(path.join(tmpdir(), "ping-client-output-"));
  try {
    mkdirSync(path.join(cwd, ".next/static"), { recursive: true });
    run((relative, contents) => {
      const target = path.join(cwd, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }, () => spawnSync(process.execPath, [checker], { cwd, encoding: "utf8", env: { NODE_ENV: "production" } }));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

it.each([
  ["PULSO_APP_TOKEN", ".next/static/checkout.js"],
  ["PULSO_WEBHOOK_SECRET", ".next/server/app/checkout.rsc"],
  ["PULSO_PROTECTION_BYPASS", "public/checkout.html"],
  ["BATIDA_AFFILIATE_CHECKOUT_SECRET", ".next/server/app/checkout.meta"],
])("blocks %s if serialized in public output", (key, file) => {
  fixture((write, check) => {
    write(".env.production.local", `${key}=${value}`);
    write(file, encodeURIComponent(value));
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public output: " + key);
    expect(result.stderr + result.stdout).not.toContain(value);
    expect(result.stderr + result.stdout).not.toContain(encodeURIComponent(value));
  });
});

it("rejects a private name prefixed for the browser, while allowing backend code", () => {
  fixture((write, check) => {
    write(".env.production.local", "PULSO_APP_TOKEN=" + value);
    write(".next/server/app/private.js", value);
    expect(check().status).toBe(0);
    write(".env.production.local", "NEXT_PUBLIC_PULSO_APP_TOKEN=" + value);
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public prefix: NEXT_PUBLIC_PULSO_APP_TOKEN");
    expect(result.stderr).not.toContain(value);
  });
});
