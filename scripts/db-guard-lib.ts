/**
 * Pure checks behind scripts/db-guard.ts (the "Production database"
 * workflow). Nothing here connects anywhere or prints a value, so it can be
 * unit-tested and never leaks a connection string into a log.
 */
import { createHash } from "node:crypto";

export type CheckResult = { ok: boolean; problems: string[] };

export type TargetKind = "transaction-pooler" | "session-pooler";

const EXPECTED_PORT: Record<TargetKind, string> = {
  "transaction-pooler": "6543",
  "session-pooler": "5432",
};

/**
 * Confirms a Supabase pooler URL points at the expected project. The pooler
 * routes by the user name (`postgres.<project ref>`), so that is what decides
 * which project a migration lands in. Problems describe what is wrong without
 * echoing any part of the URL.
 */
export function checkSupabaseTarget(
  rawUrl: string | undefined,
  expectedRef: string,
  kind: TargetKind
): CheckResult {
  const problems: string[] = [];
  if (!rawUrl) return { ok: false, problems: [`${kind}: URL is not set`] };
  if (!/^[a-z0-9]{20}$/.test(expectedRef)) {
    return { ok: false, problems: ["EXPECTED_PROJECT_REF is not a Supabase project ref"] };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, problems: [`${kind}: URL does not parse`] };
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    problems.push(`${kind}: scheme is not postgresql://`);
  }
  if (decodeURIComponent(url.username) !== `postgres.${expectedRef}`) {
    problems.push(`${kind}: user does not belong to the expected project`);
  }
  if (!url.password) problems.push(`${kind}: password is missing`);
  if (!url.hostname.endsWith(".pooler.supabase.com")) {
    problems.push(`${kind}: host is not a Supabase pooler`);
  }
  if (url.port !== EXPECTED_PORT[kind]) {
    problems.push(`${kind}: port must be ${EXPECTED_PORT[kind]}`);
  }
  if (url.pathname.replace(/^\//, "") !== "postgres") {
    problems.push(`${kind}: database name must be postgres`);
  }

  return { ok: problems.length === 0, problems };
}

/** Parts of a connection string that must never reach a log. */
export function secretFragments(rawUrl: string | undefined): string[] {
  if (!rawUrl) return [];
  try {
    const url = new URL(rawUrl);
    return [
      rawUrl,
      url.password,
      decodeURIComponent(url.password),
      url.username,
      decodeURIComponent(url.username),
      url.hostname,
    ].filter((part) => part.length >= 4);
  } catch {
    return [rawUrl];
  }
}

export function redact(message: string, fragments: string[]): string {
  let out = message;
  for (const fragment of [...fragments].sort((a, b) => b.length - a.length)) {
    out = out.split(fragment).join("***");
  }
  return out;
}

export type LocalMigration = { name: string; checksum: string };

export type AppliedMigration = {
  migration_name: string;
  checksum: string;
  finished_at: Date | string | null;
  rolled_back_at: Date | string | null;
};

/** Prisma stores the SHA-256 of each migration.sql in _prisma_migrations. */
export function migrationChecksum(sql: string | Buffer): string {
  return createHash("sha256").update(sql).digest("hex");
}

export type MigrationHistory = {
  pending: string[];
  problems: string[];
};

/**
 * Separates the expected state (migrations not applied yet) from real
 * failures in the migration history: a failed or half-applied migration, a
 * migration the database has but the repository does not, or one whose file
 * changed after it was applied. Mirrors the checks `prisma migrate deploy`
 * refuses on, so the workflow stops before it gets that far.
 */
export function classifyMigrationHistory(
  local: LocalMigration[],
  applied: AppliedMigration[]
): MigrationHistory {
  const problems: string[] = [];
  const localByName = new Map(local.map((m) => [m.name, m]));
  const appliedNames = new Set<string>();

  for (const row of applied) {
    if (row.rolled_back_at) continue;
    if (!row.finished_at) {
      problems.push(`migration ${row.migration_name} started but did not finish`);
      continue;
    }
    appliedNames.add(row.migration_name);
    const match = localByName.get(row.migration_name);
    if (!match) {
      problems.push(`migration ${row.migration_name} is applied but missing from prisma/migrations`);
    } else if (match.checksum !== row.checksum) {
      problems.push(`migration ${row.migration_name} was modified after it was applied`);
    }
  }

  const pending = local.map((m) => m.name).filter((name) => !appliedNames.has(name));
  return { pending, problems };
}

export type DatabaseState = "empty" | "managed" | "foreign";

/**
 * empty   -> nothing in public, safe first deploy
 * managed -> public is owned by Prisma (has _prisma_migrations)
 * foreign -> objects in public that Prisma did not create: wrong database?
 */
export function classifyDatabaseState(publicRelations: string[]): DatabaseState {
  if (publicRelations.length === 0) return "empty";
  return publicRelations.includes("_prisma_migrations") ? "managed" : "foreign";
}

export type DataApiState = "enabled" | "disabled" | "unknown";

/**
 * Reads the Data API state from a REST probe for a table name. With the API
 * on, PostgREST answers from the `public` schema cache (200, 401/42501 for a
 * real table, or PGRST205 naming `public.<table>`). With it off, Supabase
 * points PostgREST at an empty placeholder schema, so nothing mentions
 * `public`. Anything not recognised is "unknown" and the workflow treats it
 * as a failure.
 */
export function classifyDataApiProbe(status: number, body: string): DataApiState {
  if (body.includes("pg_pgrst_no_exposed_schemas") || body.includes("pgrst_no_exposed_schemas")) {
    return "disabled";
  }
  if (status >= 200 && status < 300) return "enabled";
  if (/public\./.test(body) || body.includes("42501")) return "enabled";
  if (status === 404 && !body.includes("PGRST")) return "disabled";
  return "unknown";
}

export type PrivilegeExposure = {
  tables: string[];
  sequences: string[];
  functions: string[];
  defaultAcls: string[];
};

export function exposureProblems(exposure: PrivilegeExposure): string[] {
  const problems: string[] = [];
  if (exposure.tables.length) problems.push(`API roles can reach tables: ${exposure.tables.join(", ")}`);
  if (exposure.sequences.length) problems.push(`API roles can use sequences: ${exposure.sequences.join(", ")}`);
  if (exposure.functions.length) problems.push(`API roles can execute functions: ${exposure.functions.join(", ")}`);
  if (exposure.defaultAcls.length) {
    problems.push(`default privileges still grant API roles: ${exposure.defaultAcls.join(", ")}`);
  }
  return problems;
}

/** True when a default ACL grants anything to anon, authenticated or PUBLIC. */
export function defaultAclExposesApiRoles(acl: string): boolean {
  const items = acl.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
  return items.some((item) => /^(anon|authenticated)=/.test(item) || item.startsWith("="));
}
