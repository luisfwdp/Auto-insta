import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const schema = `lead_capture_${randomUUID().replaceAll("-", "")}`;
const migration = readFileSync(
  new URL("../prisma/migrations/20261127140000_campaign_lead_capture/migration.sql", import.meta.url),
  "utf8",
);

describe.skipIf(!url)("campaign lead database contract", () => {
  let sql: Client;
  beforeAll(async () => {
    sql = new Client({ connectionString: url });
    await sql.connect();
    await sql.query("BEGIN");
    await sql.query(`CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}", public;
      CREATE TABLE "Automation" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL);
      CREATE TABLE "TrackedLink" ("id" TEXT PRIMARY KEY);
      INSERT INTO "Automation" VALUES ('first', 'workspace1');
      INSERT INTO "TrackedLink" VALUES ('existing');
    `);
    await sql.query(migration);
  });
  afterAll(async () => {
    if (sql) {
      await sql.query("ROLLBACK");
      await sql.end();
    }
  });

  it("leaves existing links opt-out and enforces RLS without public privileges", async () => {
    expect((await sql.query('SELECT "requireLead" FROM "TrackedLink"')).rows).toEqual([{ requireLead: false }]);
    const { rows } = await sql.query(`
      SELECT c.relrowsecurity AS enabled,
        EXISTS (SELECT 1 FROM aclexplode(c.relacl) acl WHERE acl.grantee = 0) AS public_access
      FROM pg_class c WHERE oid = '"CampaignLead"'::regclass
    `);
    expect(rows).toEqual([{ enabled: true, public_access: false }]);
    const roles = await sql.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [
      ["anon", "authenticated", "service_role", "pingchat_runtime"],
    ]);
    for (const { rolname } of roles.rows) {
      const rights = await sql.query(`
        SELECT has_table_privilege($1, '"CampaignLead"', 'SELECT,INSERT,DELETE') AS read_or_write,
               has_table_privilege($1, '"CampaignLead"', 'UPDATE,TRUNCATE') AS elevated
      `, [rolname]);
      expect(rights.rows).toEqual([{ read_or_write: rolname === "pingchat_runtime", elevated: false }]);
    }
  });

  it("rejects a foreign workspace, deduplicates submissions and cleans up with the campaign", async () => {
    const id = randomUUID();
    const insert = `INSERT INTO "CampaignLead" ("id", "workspaceId", "automationId", "sourceLinkId", "contactCiphertext")
      VALUES ($1, $2, 'first', 'existing', 'fake-ciphertext') ON CONFLICT ("id") DO NOTHING`;
    await sql.query("SAVEPOINT foreign_workspace");
    try {
      await expect(sql.query(insert, [id, "foreign"])).rejects.toMatchObject({ code: "23503" });
    } finally {
      await sql.query("ROLLBACK TO SAVEPOINT foreign_workspace");
    }
    expect((await sql.query(insert, [id, "workspace1"])).rowCount).toBe(1);
    expect((await sql.query(insert, [id, "workspace1"])).rowCount).toBe(0);
    await sql.query('DELETE FROM "TrackedLink" WHERE id = \'existing\'');
    expect((await sql.query('SELECT id FROM "CampaignLead"')).rows).toEqual([{ id }]);
    await sql.query('DELETE FROM "Automation" WHERE id = \'first\'');
    expect((await sql.query('SELECT id FROM "CampaignLead"')).rows).toEqual([]);
  });
});
