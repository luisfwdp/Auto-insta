/**
 * Production database guard, run by .github/workflows/production-database.yml.
 *
 *   tsx scripts/db-guard.ts preflight   read-only; fails closed before any write
 *   tsx scripts/db-guard.ts harden      revokes Supabase API role privileges
 *   tsx scripts/db-guard.ts verify      read-only; post-migration acceptance
 *
 * Every check either passes or exits non-zero. Nothing prints a connection
 * string: output is check names, counts and object names only, and any error
 * text is redacted before it is logged.
 *
 * Environment:
 *   DATABASE_URL_SESSION      session pooler (5432), used for all queries here
 *   DATABASE_URL_POOLER       transaction pooler (6543), validated, used by db:check
 *   EXPECTED_PROJECT_REF      Supabase project ref the URLs must belong to
 *   SUPABASE_PUBLISHABLE_KEY  public key, for the Data API probe
 *   REQUIRE_EMPTY             "true": preflight requires an empty public schema
 *   EXPECT_HARDENED           "true": preflight also requires no API role access
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import {
  checkSupabaseTarget,
  classifyDataApiProbe,
  classifyDatabaseState,
  classifyMigrationHistory,
  exposureProblems,
  migrationChecksum,
  redact,
  secretFragments,
  type AppliedMigration,
  type LocalMigration,
} from "./db-guard-lib";
import { apiRolesPresent, privilegeExposure, publicRelations } from "./db-guard-db";
const MIGRATIONS_DIR = path.resolve(__dirname, "../prisma/migrations");
const HARDEN_SQL = path.resolve(__dirname, "sql/supabase-revoke-api-roles.sql");

const sessionUrl = process.env.DATABASE_URL_SESSION;
const poolerUrl = process.env.DATABASE_URL_POOLER;
const expectedRef = process.env.EXPECTED_PROJECT_REF ?? "";
const fragments = [...secretFragments(sessionUrl), ...secretFragments(poolerUrl)];

let failures = 0;

function log(message: string) {
  console.log(redact(message, fragments));
}

function pass(name: string, detail = "") {
  log(`ok   ${name}${detail ? ` (${detail})` : ""}`);
}

function fail(name: string, problems: string[]) {
  failures++;
  log(`FAIL ${name}`);
  for (const problem of problems) log(`     - ${problem}`);
}

function localMigrations(): LocalMigration[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(MIGRATIONS_DIR, name, "migration.sql")))
    .sort()
    .map((name) => ({
      name,
      checksum: migrationChecksum(readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"))),
    }));
}

function checkTargets() {
  for (const [url, kind] of [
    [sessionUrl, "session-pooler"],
    [poolerUrl, "transaction-pooler"],
  ] as const) {
    const result = checkSupabaseTarget(url, expectedRef, kind);
    if (result.ok) pass(`${kind} belongs to project ${expectedRef}`);
    else fail(`${kind} target`, result.problems);
  }
}

async function checkDataApi() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!key) {
    fail("Data API disabled", ["SUPABASE_PUBLISHABLE_KEY is not set, so the Data API cannot be probed"]);
    return;
  }
  // A table that exists once migrations are applied. Its name is not secret.
  const probe = `https://${expectedRef}.supabase.co/rest/v1/Session?select=id&limit=1`;
  try {
    const response = await fetch(probe, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    const state = classifyDataApiProbe(response.status, body);
    if (state === "disabled") pass("Data API disabled", `HTTP ${response.status}`);
    else {
      fail("Data API disabled", [
        state === "enabled"
          ? `the REST API still answers from the public schema (HTTP ${response.status})`
          : `unrecognised REST response (HTTP ${response.status}); treating as enabled`,
      ]);
    }
  } catch (error) {
    fail("Data API disabled", [`probe failed: ${(error as Error).message}`]);
  }
}

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: sessionUrl, connectionTimeoutMillis: 15_000 });
  await client.connect();
  return client;
}

async function checkMigrationHistory(client: Client, relations: string[]) {
  const local = localMigrations();
  let applied: AppliedMigration[] = [];
  if (relations.includes("_prisma_migrations")) {
    ({ rows: applied } = await client.query<AppliedMigration>(
      `SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations`
    ));
  }
  const history = classifyMigrationHistory(local, applied);
  if (history.problems.length) fail("migration history", history.problems);
  else pass("migration history consistent", `${local.length} local, ${history.pending.length} pending`);
  return history;
}

async function checkPrivileges(client: Client, required: boolean) {
  if (!(await apiRolesPresent(client))) {
    fail("Supabase API roles present", ["anon/authenticated roles not found: this is not a Supabase database"]);
    return;
  }
  const problems = exposureProblems(await privilegeExposure(client));
  if (problems.length === 0) pass("no privileges for anon/authenticated in public");
  else if (required) fail("no privileges for anon/authenticated in public", problems);
  else for (const problem of problems) log(`note ${problem} (hardening runs before and after migrate)`);
}

async function preflight() {
  checkTargets();
  if (failures) return; // never connect to a URL that failed validation
  await checkDataApi();

  const client = await connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    pass("connected over session pooler (read-only session)");

    const relations = await publicRelations(client);
    const state = classifyDatabaseState(relations);
    if (state === "foreign") {
      fail("database state", [`public has objects but no _prisma_migrations: ${relations.join(", ")}`]);
    } else if (process.env.REQUIRE_EMPTY === "true" && state !== "empty") {
      fail("database empty", [`expected an empty public schema for the first deploy, found ${relations.length} relations`]);
    } else {
      pass("database state", `${state}, ${relations.length} relations in public`);
    }

    await checkMigrationHistory(client, relations);
    await checkPrivileges(client, process.env.EXPECT_HARDENED === "true");
  } finally {
    await client.end();
  }
}

async function harden() {
  checkTargets();
  if (failures) return;
  const client = await connect();
  try {
    if (!(await apiRolesPresent(client))) {
      fail("Supabase API roles present", ["anon/authenticated roles not found: refusing to run"]);
      return;
    }
    await client.query(readFileSync(HARDEN_SQL, "utf8"));
    pass("revoked API role privileges in public (idempotent)");
  } finally {
    await client.end();
  }
}

async function verify() {
  checkTargets();
  if (failures) return;
  await checkDataApi();
  const client = await connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    const relations = await publicRelations(client);
    if (classifyDatabaseState(relations) !== "managed") {
      fail("database state", ["_prisma_migrations not found after migrate"]);
    }
    const history = await checkMigrationHistory(client, relations);
    if (history.pending.length) fail("all migrations applied", [`pending: ${history.pending.join(", ")}`]);
    else pass("all migrations applied", `${relations.length} relations in public`);
    await checkPrivileges(client, true);
  } finally {
    await client.end();
  }
}

async function main() {
  const mode = process.argv[2];
  const run = { preflight, harden, verify }[mode ?? ""];
  if (!run) {
    console.error("usage: tsx scripts/db-guard.ts preflight|harden|verify");
    process.exit(2);
  }
  await run();
  if (failures) {
    log(`${failures} check(s) failed. Stopping.`);
    process.exit(1);
  }
  log("All checks passed.");
}

main().catch((error: Error & { code?: string }) => {
  log(`FAIL unexpected error${error.code ? ` [${error.code}]` : ""}: ${error.message}`);
  process.exit(1);
});
