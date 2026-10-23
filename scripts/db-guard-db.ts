/**
 * Read-only catalog queries for scripts/db-guard.ts, split out so the
 * database tests can run them against a throwaway Postgres.
 */
import type { Client } from "pg";
import { defaultAclExposesApiRoles, type PrivilegeExposure } from "./db-guard-lib";

export const API_ROLES = ["anon", "authenticated"] as const;

export async function publicRelations(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ relname: string }>(`
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
    ORDER BY 1`);
  return rows.map((row) => row.relname);
}

export async function apiRolesPresent(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)`,
    [API_ROLES]
  );
  return rows[0].n === API_ROLES.length;
}

export async function privilegeExposure(client: Client): Promise<PrivilegeExposure> {
  const roleCheck = (fn: string, privileges: string) =>
    API_ROLES.map((role) => `${fn}('${role}', c.oid, '${privileges}')`).join(" OR ");

  const tables = await client.query<{ name: string }>(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
      AND (${roleCheck("has_table_privilege", "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER")})
    ORDER BY 1`);
  const sequences = await client.query<{ name: string }>(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
      AND (${roleCheck("has_sequence_privilege", "USAGE,SELECT,UPDATE")})
    ORDER BY 1`);
  const functions = await client.query<{ name: string }>(`
    SELECT c.oid::regprocedure::text AS name FROM pg_proc c JOIN pg_namespace n ON n.oid = c.pronamespace
    WHERE n.nspname = 'public' AND (${roleCheck("has_function_privilege", "EXECUTE")})
    ORDER BY 1`);
  const defaults = await client.query<{ objtype: string; acl: string; global: boolean }>(`
    SELECT d.defaclobjtype AS objtype, d.defaclacl::text AS acl, d.defaclnamespace = 0 AS global
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE d.defaclrole = 'postgres'::regrole AND (n.nspname = 'public' OR d.defaclnamespace = 0)`);

  const objType: Record<string, string> = { r: "tables", S: "sequences", f: "functions", T: "types", n: "schemas" };
  const defaultAcls = defaults.rows
    .filter((row) => row.objtype !== "T" && row.objtype !== "n" && defaultAclExposesApiRoles(row.acl))
    .map((row) => `${row.global ? "global " : "public "}${objType[row.objtype] ?? row.objtype}`);
  // Without a global entry, Postgres's built-in default gives EXECUTE on every
  // new function to PUBLIC (which includes anon), whatever the schema says.
  if (!defaults.rows.some((row) => row.global && row.objtype === "f")) {
    defaultAcls.push("global functions (built-in EXECUTE to PUBLIC)");
  }
  return {
    tables: tables.rows.map((row) => row.name),
    sequences: sequences.rows.map((row) => row.name),
    functions: functions.rows.map((row) => row.name),
    defaultAcls,
  };
}

