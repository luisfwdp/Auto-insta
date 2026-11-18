/** Real adapter/SQL rollout proof on an isolated PostgreSQL schema only. */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { PrismaClient } from "../app/generated/prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL, schema = `commercial_rollout_${randomBytes(5).toString("hex")}`;
const candidate = "20261118040000_commercial_usage";
let sql: Client, db: PrismaClient;

describe.skipIf(!url)("commercial additive migration ordering", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: url }); await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const name of readdirSync(root, { withFileTypes: true }).filter(file => file.isDirectory() && file.name !== candidate).map(file => file.name).sort())
      await sql.query(readFileSync(path.join(root, name, "migration.sql"), "utf8"));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2, options: `-c search_path=${schema}` }, { schema }) });
    await sql.query(`INSERT INTO "User" ("id","email","updatedAt") VALUES ('rollout-owner','rollout-owner@example.test',NOW())`);
    await sql.query(`INSERT INTO "Workspace" ("id","name","ownerId","updatedAt") VALUES ('rollout-workspace','Retained workspace','rollout-owner',NOW())`);
    await sql.query(`INSERT INTO "Session" ("id","sessionToken","userId","expires") VALUES ('rollout-session','local-disposable-session-only','rollout-owner',NOW()+INTERVAL '1 day')`);
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });
  it("requires the approved additive migration before the new client is deployed, and preserves old rows and projections", async () => {
    const adapter = PrismaAdapter(db as unknown as Parameters<typeof PrismaAdapter>[0]);
    // Feature flags do not change the adapter's implicit user scalar selection.
    // Publishing this client first breaks authentication even with sales OFF.
    await expect(adapter.getSessionAndUser!("local-disposable-session-only")).rejects.toMatchObject({ code: "P2022" });
    const old = await sql.query(`SELECT u."id",u."email",u."name",u."image",s."id" AS "sessionId",w."name" AS "workspaceName"
      FROM "User" u JOIN "Session" s ON s."userId"=u."id" JOIN "Workspace" w ON w."ownerId"=u."id"`);
    await sql.query(readFileSync(path.join(__dirname, "..", "prisma", "migrations", candidate, "migration.sql"), "utf8"));
    const session = await adapter.getSessionAndUser!("local-disposable-session-only");
    expect(session?.user.id).toBe("rollout-owner"); expect(session?.session.userId).toBe("rollout-owner");
    expect(await db.user.findUnique({ where: { id: "rollout-owner" }, select: { activeWorkspaceId: true } })).toEqual({ activeWorkspaceId: null });
    const after = await sql.query(`SELECT u."id",u."email",u."name",u."image",s."id" AS "sessionId",w."name" AS "workspaceName"
      FROM "User" u JOIN "Session" s ON s."userId"=u."id" JOIN "Workspace" w ON w."ownerId"=u."id"`);
    expect(after.rows).toEqual(old.rows);
  });
});
