import { describe, expect, it } from "vitest";
import {
  checkSupabaseTarget,
  classifyDataApiProbe,
  classifyDatabaseState,
  classifyMigrationHistory,
  defaultAclExposesApiRoles,
  exposureProblems,
  migrationChecksum,
  redact,
  secretFragments,
} from "../scripts/db-guard-lib";

const REF = "abcdefghijklmnopqrst";
const SESSION = `postgresql://postgres.${REF}:s3cr3t-pass@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;
const POOLER = SESSION.replace(":5432/", ":6543/");

describe("checkSupabaseTarget", () => {
  it("accepts the project's session and transaction poolers", () => {
    expect(checkSupabaseTarget(SESSION, REF, "session-pooler")).toEqual({ ok: true, problems: [] });
    expect(checkSupabaseTarget(POOLER, REF, "transaction-pooler").ok).toBe(true);
  });

  it("rejects another project's URL", () => {
    const other = SESSION.replace(REF, "zzzzzzzzzzzzzzzzzzzz");
    const result = checkSupabaseTarget(other, REF, "session-pooler");
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toMatch(/expected project/);
  });

  it("rejects the wrong port, a direct host, a missing URL and a bad ref", () => {
    expect(checkSupabaseTarget(POOLER, REF, "session-pooler").ok).toBe(false);
    expect(
      checkSupabaseTarget(SESSION.replace("aws-0-sa-east-1.pooler.supabase.com", `db.${REF}.supabase.co`), REF, "session-pooler").ok
    ).toBe(false);
    expect(checkSupabaseTarget(undefined, REF, "session-pooler").ok).toBe(false);
    expect(checkSupabaseTarget(SESSION, "", "session-pooler").ok).toBe(false);
    expect(checkSupabaseTarget("not a url", REF, "session-pooler").ok).toBe(false);
  });

  it("never echoes the URL in its problems", () => {
    const result = checkSupabaseTarget(SESSION.replace(":5432/", ":1234/"), "zzzzzzzzzzzzzzzzzzzz", "session-pooler");
    for (const problem of result.problems) {
      expect(problem).not.toContain("s3cr3t-pass");
      expect(problem).not.toContain("pooler.supabase.com");
      expect(problem).not.toContain(REF);
    }
  });
});

describe("redact", () => {
  it("removes password, user and host from error text", () => {
    const message = `connect failed for postgres.${REF}:s3cr3t-pass@aws-0-sa-east-1.pooler.supabase.com`;
    const out = redact(message, secretFragments(SESSION));
    expect(out).not.toContain("s3cr3t-pass");
    expect(out).not.toContain("pooler.supabase.com");
    expect(out).not.toContain(`postgres.${REF}`);
  });
});

describe("classifyMigrationHistory", () => {
  const local = [
    { name: "001_init", checksum: migrationChecksum("CREATE TABLE a();") },
    { name: "002_more", checksum: migrationChecksum("CREATE TABLE b();") },
  ];
  const applied = (name: string, sql: string, extra = {}) => ({
    migration_name: name,
    checksum: migrationChecksum(sql),
    finished_at: new Date(),
    rolled_back_at: null,
    ...extra,
  });

  it("reports pending migrations on an empty database without problems", () => {
    expect(classifyMigrationHistory(local, [])).toEqual({ pending: ["001_init", "002_more"], problems: [] });
  });

  it("is clean when everything is applied", () => {
    const history = classifyMigrationHistory(local, [
      applied("001_init", "CREATE TABLE a();"),
      applied("002_more", "CREATE TABLE b();"),
    ]);
    expect(history).toEqual({ pending: [], problems: [] });
  });

  it("flags a failed migration, an unknown one and a modified one", () => {
    const history = classifyMigrationHistory(local, [
      applied("001_init", "CREATE TABLE a(changed int);"),
      applied("002_more", "CREATE TABLE b();", { finished_at: null }),
      applied("999_elsewhere", "x"),
    ]);
    expect(history.problems).toHaveLength(3);
    expect(history.problems.join("\n")).toMatch(/modified after it was applied/);
    expect(history.problems.join("\n")).toMatch(/did not finish/);
    expect(history.problems.join("\n")).toMatch(/missing from prisma\/migrations/);
  });

  it("treats a rolled-back migration as pending, not as a problem", () => {
    const history = classifyMigrationHistory(local, [
      applied("001_init", "CREATE TABLE a();"),
      applied("002_more", "CREATE TABLE b();", { finished_at: null, rolled_back_at: new Date() }),
    ]);
    expect(history).toEqual({ pending: ["002_more"], problems: [] });
  });
});

describe("classifyDatabaseState", () => {
  it("separates empty, Prisma-managed and foreign databases", () => {
    expect(classifyDatabaseState([])).toBe("empty");
    expect(classifyDatabaseState(["User", "_prisma_migrations"])).toBe("managed");
    expect(classifyDatabaseState(["todos"])).toBe("foreign");
  });
});

describe("classifyDataApiProbe", () => {
  it("reads an enabled API from the public schema cache", () => {
    expect(
      classifyDataApiProbe(404, `{"code":"PGRST205","message":"Could not find the table 'public.Session' in the schema cache"}`)
    ).toBe("enabled");
    expect(classifyDataApiProbe(200, "[]")).toBe("enabled");
    expect(classifyDataApiProbe(401, `{"code":"42501","message":"permission denied for table Session"}`)).toBe("enabled");
  });

  it("reads a disabled API from the placeholder schema", () => {
    expect(
      classifyDataApiProbe(404, `{"code":"PGRST205","message":"Could not find the table 'pg_pgrst_no_exposed_schemas.Session'"}`)
    ).toBe("disabled");
    expect(classifyDataApiProbe(404, "Not Found")).toBe("disabled");
  });

  it("recognises the schema-cache failure a disabled API produces, but not as final", () => {
    expect(
      classifyDataApiProbe(503, `{"code":"PGRST002","message":"Could not query the database for the schema cache. Retrying."}`)
    ).toBe("no-schema-cache");
  });

  it("fails closed on anything else", () => {
    expect(classifyDataApiProbe(500, "upstream error")).toBe("unknown");
    expect(classifyDataApiProbe(404, `{"code":"PGRST002"}`)).toBe("unknown");
    expect(classifyDataApiProbe(503, "Service Unavailable")).toBe("unknown");
  });
});

describe("privilege checks", () => {
  it("detects default ACLs that grant API roles or PUBLIC", () => {
    expect(defaultAclExposesApiRoles("{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres}")).toBe(true);
    expect(defaultAclExposesApiRoles("{=X/postgres,postgres=X/postgres}")).toBe(true);
    expect(defaultAclExposesApiRoles("{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}")).toBe(false);
  });

  it("lists every exposure as a problem", () => {
    expect(exposureProblems({ tables: [], sequences: [], functions: [], defaultAcls: [] })).toEqual([]);
    expect(
      exposureProblems({ tables: ["Session"], sequences: ["s"], functions: ["f()"], defaultAcls: ["public tables"] })
    ).toHaveLength(4);
  });
});
