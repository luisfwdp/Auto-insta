/**
 * The Supabase hardening SQL and the privilege checks behind the
 * production-database workflow, against a real Postgres.
 *
 * Runs only with TEST_DATABASE_URL (superuser on a disposable server, as in
 * CI). It creates its own throwaway database, recreates Supabase's default
 * grants to anon/authenticated/service_role there, applies every Prisma
 * migration, then checks that scripts/sql/supabase-revoke-api-roles.sql
 * removes all API role access and keeps new objects private.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRolesPresent, privilegeExposure, publicRelations } from "../scripts/db-guard-db";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const ROLES = ["anon", "authenticated", "service_role"];
const HARDEN_SQL = readFileSync(path.resolve(__dirname, "../scripts/sql/supabase-revoke-api-roles.sql"), "utf8");
const MIGRATIONS_DIR = path.resolve(__dirname, "../prisma/migrations");

describe.skipIf(!DATABASE_URL)("Supabase API role hardening", () => {
  const dbName = `guard_test_${process.pid}_${Date.now()}`;
  let admin: Client;
  let db: Client;
  const createdRoles: string[] = [];

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    for (const role of ROLES) {
      const { rowCount } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (!rowCount) {
        await admin.query(`CREATE ROLE ${role} NOLOGIN`);
        createdRoles.push(role);
      }
    }
    await admin.query(`CREATE DATABASE ${dbName}`);

    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    db = new Client({ connectionString: url.toString() });
    await db.connect();

    // Supabase's defaults: every new object in public is granted to the API roles.
    await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role`);
    await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role`);
    await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role`);

    const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of migrations) {
      await db.query(readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"));
    }
    await db.query(`CREATE SEQUENCE public.guard_seq`);
    await db.query(`CREATE FUNCTION public.guard_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      for (const role of createdRoles) await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });

  it("sees the Supabase roles and the migrated tables", async () => {
    expect(await apiRolesPresent(db)).toBe(true);
    expect(await publicRelations(db)).toContain("Session");
  });

  it("reports the exposure Supabase's defaults create", async () => {
    const exposure = await privilegeExposure(db);
    expect(exposure.tables).toContain("Session");
    expect(exposure.tables).toContain("Account");
    expect(exposure.sequences).toContain("guard_seq");
    expect(exposure.functions).toContain("guard_fn()");
    expect(exposure.defaultAcls.length).toBeGreaterThan(0);
  });

  it("removes every API role privilege, and is idempotent", async () => {
    await db.query(HARDEN_SQL);
    await db.query(HARDEN_SQL);
    expect(await privilegeExposure(db)).toEqual({ tables: [], sequences: [], functions: [], defaultAcls: [] });
  });

  it("keeps objects created after hardening private", async () => {
    await db.query(`CREATE TABLE public.guard_later (id serial PRIMARY KEY)`);
    await db.query(`CREATE FUNCTION public.guard_later_fn() RETURNS int LANGUAGE sql AS 'SELECT 2'`);
    const { rows } = await db.query<{ t: boolean; f: boolean; s: boolean }>(`
      SELECT has_table_privilege('anon', 'public.guard_later', 'SELECT') AS t,
             has_function_privilege('anon', 'public.guard_later_fn()', 'EXECUTE') AS f,
             has_table_privilege('service_role', 'public.guard_later', 'SELECT') AS s`);
    expect(rows[0]).toEqual({ t: false, f: false, s: false });
    expect(await privilegeExposure(db)).toEqual({ tables: [], sequences: [], functions: [], defaultAcls: [] });
  });

  it("refuses to run where the Supabase roles do not exist", async () => {
    await expect(
      db.query(HARDEN_SQL.replace("'service_role')", "'role_that_does_not_exist')"))
    ).rejects.toThrow(/Supabase API roles not found/);
  });
});
