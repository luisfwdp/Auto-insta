/**
 * Workspace isolation, tested against a real Postgres.
 *
 * Two workspaces, each with its own owner, Instagram account, campaign, DM log,
 * tracked link and operational event. Signed in as the owner of workspace B,
 * every dashboard API route is called with workspace A's ids, and the tests
 * check that nothing from A is returned or changed. Only the session lookup is
 * mocked: workspace resolution (lib/auth, lib/workspace-access) and every query
 * run for real, so a missing `workspaceId` filter shows up here.
 *
 * Needs a disposable database and is skipped without one:
 *
 *   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/postgres \
 *     npx vitest run __tests__/workspace-isolation.db.test.ts
 *
 * Each run builds the schema from prisma/migrations inside its own throwaway
 * Postgres schema and drops it at the end, so it never touches existing data.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  userId: null as string | null,
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));

// The only thing faked is "who is signed in". Everything that turns a user into
// a workspace runs against the database.
vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    auth: async () => (state.userId ? { user: { id: state.userId } } : null),
    signIn: async () => undefined,
    signOut: async () => undefined,
  }),
}));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));

// Diagnostics reads queue and worker state from Redis; neither is tenant data.
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({
    getJobCounts: async () => ({}),
  }),
}));
vi.mock("@/lib/ops/worker-health", () => ({
  getWorkerHealth: async () => ({ healthy: true }),
  getWorkerAlerts: async () => [],
}));

import * as automationsRoute from "../app/api/automations/route";
import * as duplicateRoute from "../app/api/automations/duplicate/route";
import * as importRoute from "../app/api/automations/import/route";
import * as logsRoute from "../app/api/logs/route";
import * as accountsRoute from "../app/api/instagram/accounts/route";
import * as disconnectRoute from "../app/api/instagram/disconnect/route";
import * as statsRoute from "../app/api/dashboard/stats/route";
import * as membersRoute from "../app/api/workspace/members/route";
import * as diagnosticsRoute from "../app/api/admin/diagnostics/route";

const schema = `workspace_isolation_${randomBytes(4).toString("hex")}`;
let sql: Client;

const A = {
  user: "user_a",
  member: "member_a_owner",
  extraUser: "user_a_extra",
  extraMember: "member_a_extra",
  workspace: "workspace_a",
  account: "account_a",
  instagramId: "ig_a",
  automation: "automation_a",
  link: "link_a",
  invitation: "invitation_a",
};
const B = {
  user: "user_b",
  member: "member_b_owner",
  workspace: "workspace_b",
  account: "account_b",
  instagramId: "ig_b",
  automation: "automation_b",
};

function migrationDirs() {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function request(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Every id that belongs to workspace A must stay out of B's responses.
const A_IDS = [A.workspace, A.account, A.instagramId, A.automation, A.link, A.member, A.extraMember];

function expectNoWorkspaceAData(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const id of A_IDS) expect(text).not.toContain(id);
  expect(text).not.toContain("secret-token-a");
  expect(text).not.toContain("Campaign A");
  expect(text).not.toContain("commenter_a");
}

async function workspaceASnapshot() {
  return {
    automation: await state.db.automation.findUnique({ where: { id: A.automation } }),
    account: await state.db.instagramAccount.findUnique({ where: { id: A.account } }),
    automations: await state.db.automation.count({ where: { workspaceId: A.workspace } }),
    members: await state.db.workspaceMember.findMany({
      where: { workspaceId: A.workspace },
      orderBy: { id: "asc" },
    }),
    invitation: await state.db.workspaceInvitation.findUnique({ where: { id: A.invitation } }),
  };
}

describe.skipIf(!DATABASE_URL)("workspace isolation on a real Postgres", () => {
  let before: Awaited<ReturnType<typeof workspaceASnapshot>>;

  beforeAll(async () => {
    sql = new Client({ connectionString: DATABASE_URL });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    for (const dir of migrationDirs()) {
      await sql.query(readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
    }

    await sql.query(`
      INSERT INTO "User" ("id", "email", "updatedAt") VALUES
        ('${A.user}', 'a@test.dev', now()),
        ('${A.extraUser}', 'a-extra@test.dev', now()),
        ('${B.user}', 'b@test.dev', now());
      INSERT INTO "Workspace" ("id", "name", "ownerId", "updatedAt") VALUES
        ('${A.workspace}', 'Workspace A', '${A.user}', now()),
        ('${B.workspace}', 'Workspace B', '${B.user}', now());
      INSERT INTO "WorkspaceMember" ("id", "workspaceId", "userId", "role") VALUES
        ('${A.member}', '${A.workspace}', '${A.user}', 'OWNER'),
        ('${A.extraMember}', '${A.workspace}', '${A.extraUser}', 'MEMBER'),
        ('${B.member}', '${B.workspace}', '${B.user}', 'OWNER');
      INSERT INTO "WorkspaceInvitation" ("id", "workspaceId", "email", "role", "token", "expiresAt", "updatedAt") VALUES
        ('${A.invitation}', '${A.workspace}', 'invitee@test.dev', 'MEMBER', 'token_a', now() + interval '7 days', now());
      INSERT INTO "InstagramAccount" ("id", "workspaceId", "instagramId", "username", "accessToken", "updatedAt") VALUES
        ('${A.account}', '${A.workspace}', '${A.instagramId}', 'account_a', 'secret-token-a', now()),
        ('${B.account}', '${B.workspace}', '${B.instagramId}', 'account_b', 'secret-token-b', now());
      INSERT INTO "Automation" ("id", "workspaceId", "instagramAccountId", "name", "keywords", "dmMessage", "matchAnyPost", "reportShareSlug", "updatedAt") VALUES
        ('${A.automation}', '${A.workspace}', '${A.account}', 'Campaign A', '{LINK}', 'Message A', true, 'share_a', now()),
        ('${B.automation}', '${B.workspace}', '${B.account}', 'Campaign B', '{LINK}', 'Message B', true, 'share_b', now());
      INSERT INTO "TrackedLink" ("id", "workspaceId", "automationId", "slug", "destinationUrl", "updatedAt") VALUES
        ('${A.link}', '${A.workspace}', '${A.automation}', 'slug_a', 'https://a.example.com', now());
      INSERT INTO "DmLog" ("id", "workspaceId", "automationId", "instagramAccountId", "commenterId", "commenterName", "commentText", "commentId", "matchedKeyword", "status", "updatedAt") VALUES
        ('dmlog_a', '${A.workspace}', '${A.automation}', '${A.account}', 'commenter_a', 'commenter_a', 'LINK', 'comment_a', 'LINK', 'SENT', now()),
        ('dmlog_b', '${B.workspace}', '${B.automation}', '${B.account}', 'commenter_b', 'commenter_b', 'LINK', 'comment_b', 'LINK', 'SENT', now());
      INSERT INTO "LinkClick" ("id", "workspaceId", "automationId", "instagramAccountId", "trackedLinkId", "ipHash") VALUES
        ('click_a', '${A.workspace}', '${A.automation}', '${A.account}', '${A.link}', 'hash_a');
      INSERT INTO "WebhookEvent" ("id", "workspaceId", "payload", "status", "errorMessage") VALUES
        ('webhook_a', '${A.workspace}', '{}', 'FAILED', 'commenter_a webhook failure');
      INSERT INTO "OperationalEvent" ("id", "workspaceId", "source", "level", "message") VALUES
        ('event_a', '${A.workspace}', 'WORKER', 'ERROR', 'commenter_a worker failure');
    `);

    state.db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema }),
    });
    before = await workspaceASnapshot();
  }, 60_000);

  beforeEach(() => {
    state.userId = B.user;
  });

  afterAll(async () => {
    // Nothing a workspace B owner did may have changed workspace A.
    if (state.db && before) expect(await workspaceASnapshot()).toEqual(before);
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("rejects every route when nobody is signed in", async () => {
    state.userId = null;
    const responses = await Promise.all([
      automationsRoute.GET(request("GET", "http://localhost/api/automations")),
      logsRoute.GET(request("GET", "http://localhost/api/logs")),
      accountsRoute.GET(),
      statsRoute.GET(request("GET", "http://localhost/api/dashboard/stats")),
      membersRoute.GET(),
      diagnosticsRoute.GET(),
    ]);
    for (const res of responses) expect(res.status).toBe(401);
  });

  describe("reads", () => {
    it("lists only the signed-in workspace's campaigns, even when filtered by another account", async () => {
      for (const url of [
        "http://localhost/api/automations",
        `http://localhost/api/automations?instagramAccountId=${A.account}`,
      ]) {
        const res = await automationsRoute.GET(request("GET", url));
        expect(res.status).toBe(200);
        const body = await res.json();
        expectNoWorkspaceAData(body);
      }
      const res = await automationsRoute.GET(request("GET", "http://localhost/api/automations"));
      const body = await res.json();
      expect(JSON.stringify(body)).toContain(B.automation);
    });

    it("returns only the signed-in workspace's DM logs", async () => {
      for (const url of [
        "http://localhost/api/logs",
        `http://localhost/api/logs?instagramAccountId=${A.account}`,
      ]) {
        const res = await logsRoute.GET(request("GET", url));
        expect(res.status).toBe(200);
        expectNoWorkspaceAData(await res.json());
      }
    });

    it("lists only the signed-in workspace's Instagram accounts and never their tokens", async () => {
      const res = await accountsRoute.GET();
      const body = await res.json();
      expect(body.data.instagramAccounts.map((a: { id: string }) => a.id)).toEqual([B.account]);
      expect(JSON.stringify(body)).not.toContain("secret-token");
    });

    it("computes dashboard stats from the signed-in workspace only", async () => {
      for (const url of [
        "http://localhost/api/dashboard/stats",
        `http://localhost/api/dashboard/stats?instagramAccountId=${A.account}`,
      ]) {
        const res = await statsRoute.GET(request("GET", url));
        expect(res.status).toBe(200);
        const body = await res.json();
        // The route echoes the requested account id back as the selection; it
        // is the caller's own input, not workspace A's data, so leave it out.
        const { selectedInstagramAccountId: _echo, ...data } = body.data;
        void _echo;
        expectNoWorkspaceAData(data);
        expect(data.totalClicks).toBe(0);
      }
      const res = await statsRoute.GET(request("GET", "http://localhost/api/dashboard/stats"));
      const { data } = await res.json();
      expect(data.totalAutomations).toBe(1);
      expect(data.totalDMs).toBe(1);
      expect(data.contactsCount).toBe(1);
    });

    it("lists only the signed-in workspace's members and invitations", async () => {
      const res = await membersRoute.GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expectNoWorkspaceAData(body);
      expect(JSON.stringify(body)).not.toContain("invitee@test.dev");
    });

    it("shows diagnostics for the signed-in workspace only", async () => {
      const res = await diagnosticsRoute.GET();
      expect(res.status).toBe(200);
      expectNoWorkspaceAData(await res.json());
    });
  });

  describe("writes with another workspace's ids", () => {
    it("cannot edit another workspace's campaign", async () => {
      const res = await automationsRoute.PATCH(
        request("PATCH", `http://localhost/api/automations?id=${A.automation}`, {
          name: "Hijacked",
          keywords: ["LINK"],
          dmMessage: "Hijacked",
          isActive: false,
        })
      );
      expect(res.status).toBe(404);
    });

    it("cannot delete another workspace's campaign", async () => {
      const res = await automationsRoute.DELETE(
        request("DELETE", `http://localhost/api/automations?id=${A.automation}`)
      );
      expect(res.status).toBe(404);
    });

    it("cannot duplicate another workspace's campaign", async () => {
      const res = await duplicateRoute.POST(
        request("POST", `http://localhost/api/automations/duplicate?id=${A.automation}`)
      );
      expect(res.status).toBe(404);
      expect(await state.db.automation.count({ where: { workspaceId: B.workspace } })).toBe(1);
    });

    it("cannot create a campaign on another workspace's Instagram account", async () => {
      const res = await automationsRoute.POST(
        request("POST", "http://localhost/api/automations", {
          name: "Cross-tenant",
          instagramAccountId: A.account,
          matchAnyPost: true,
          keywords: ["LINK"],
          dmMessage: "Hello",
        })
      );
      expect(res.status).toBe(400);
      expect(await state.db.automation.count({ where: { instagramAccountId: A.account } })).toBe(1);
    });

    it("cannot import campaigns into another workspace's Instagram account", async () => {
      const res = await importRoute.POST(
        request("POST", "http://localhost/api/automations/import", {
          instagramAccountId: A.account,
          campaigns: [{ name: "Imported", postId: "post_x", keywords: ["LINK"], dmMessage: "Hi", isActive: true, wholeWordMatch: true }],
        })
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await state.db.automation.count({ where: { instagramAccountId: A.account } })).toBe(1);
    });

    it("cannot disconnect another workspace's Instagram account", async () => {
      const res = await disconnectRoute.POST(
        request("POST", "http://localhost/api/instagram/disconnect", { instagramAccountId: A.account })
      );
      expect(res.status).toBeLessThan(500);
      expect(await state.db.instagramAccount.findUnique({ where: { id: A.account } })).not.toBeNull();
    });

    it("cannot change roles, remove members or revoke invitations in another workspace", async () => {
      const patch = await membersRoute.PATCH(
        request("PATCH", "http://localhost/api/workspace/members", { memberId: A.extraMember, role: "ADMIN" })
      );
      expect(patch.status).toBeGreaterThanOrEqual(400);

      const remove = await membersRoute.DELETE(
        request("DELETE", "http://localhost/api/workspace/members", {
          memberId: A.extraMember,
        })
      );
      expect(remove.status).toBeGreaterThanOrEqual(400);

      const revoke = await membersRoute.DELETE(
        request("DELETE", "http://localhost/api/workspace/members", {
          invitationId: A.invitation,
        })
      );
      expectNoWorkspaceAData(await revoke.json());
    });
  });

  describe("roles inside a workspace", () => {
    it("does not let a MEMBER create, edit or delete campaigns", async () => {
      state.userId = A.extraUser;
      const create = await automationsRoute.POST(
        request("POST", "http://localhost/api/automations", {
          name: "By member",
          matchAnyPost: true,
          keywords: ["LINK"],
          dmMessage: "Hello",
        })
      );
      const edit = await automationsRoute.PATCH(
        request("PATCH", `http://localhost/api/automations?id=${A.automation}`, {
          name: "By member",
          keywords: ["LINK"],
          dmMessage: "Hello",
        })
      );
      const remove = await automationsRoute.DELETE(
        request("DELETE", `http://localhost/api/automations?id=${A.automation}`)
      );
      expect([create.status, edit.status, remove.status]).toEqual([403, 403, 403]);
    });

    it("does not let a MEMBER disconnect accounts or manage members", async () => {
      state.userId = A.extraUser;
      const disconnect = await disconnectRoute.POST(
        request("POST", "http://localhost/api/instagram/disconnect", { instagramAccountId: A.account })
      );
      const invite = await membersRoute.POST(
        request("POST", "http://localhost/api/workspace/members", { email: "x@test.dev" })
      );
      expect([disconnect.status, invite.status]).toEqual([403, 403]);
    });
  });
});
