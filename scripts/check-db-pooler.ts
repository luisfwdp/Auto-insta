/**
 * Read-only check that DATABASE_URL works with the app's Prisma setup.
 *
 *   DATABASE_URL='postgresql://...' npm run db:check
 *
 * Meant for a connection pooler in transaction mode (Supabase's transaction
 * pooler, PgBouncer), where every statement may land on a different server
 * connection. It uses the same adapter options as lib/db/client.ts and checks:
 *
 *   1. a basic query;
 *   2. the same parameterized query repeated many times, which is where a
 *      pooler that cannot track prepared statements fails;
 *   3. many concurrent queries over a small pool;
 *   4. an interactive transaction staying on one server connection;
 *   5. an array transaction.
 *
 * Nothing is written: every query reads pg_catalog or session functions, so it
 * is safe against production and works on an empty database, before or after
 * migrations. Exits with code 1 on the first failure.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: databaseUrl,
    max: Number(process.env.DB_POOL_MAX ?? 3),
    idleTimeoutMillis: 10_000,
  }),
});

async function check(name: string, run: () => Promise<void>) {
  const started = Date.now();
  try {
    await run();
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  // Where the URL points, without printing it: host and pooler port only.
  const url = new URL(databaseUrl!);
  console.log(`Checking ${url.hostname}:${url.port || 5432} (database ${url.pathname.slice(1)})`);

  await check("basic query", async () => {
    const rows = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1::int AS ok`;
    assert(rows[0]?.ok === 1, "SELECT 1 returned an unexpected result");
  });

  await check("same parameterized query 50 times", async () => {
    for (let i = 0; i < 50; i++) {
      const rows = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname <> ${`skip_${i}`}`;
      assert(typeof rows[0]?.n === "number", `iteration ${i} returned no count`);
    }
  });

  await check("100 concurrent queries over the pool", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        prisma.$queryRaw<{ v: number }[]>`SELECT ${i}::int AS v`
      )
    );
    results.forEach((rows, i) =>
      assert(rows[0]?.v === i, `query ${i} returned another query's result`)
    );
  });

  await check("interactive transaction keeps one server connection", async () => {
    await prisma.$transaction(async (tx) => {
      const [first] = await tx.$queryRaw<{ pid: number; xid: string }[]>`
        SELECT pg_backend_pid() AS pid, txid_current()::text AS xid`;
      const [second] = await tx.$queryRaw<{ pid: number; xid: string }[]>`
        SELECT pg_backend_pid() AS pid, txid_current()::text AS xid`;
      assert(first.pid === second.pid, "transaction moved to another server connection");
      assert(first.xid === second.xid, "statements ran in different transactions");
    });
  });

  await check("array transaction", async () => {
    const [a, b] = await prisma.$transaction([
      prisma.$queryRaw<{ v: number }[]>`SELECT ${1}::int AS v`,
      prisma.$queryRaw<{ v: number }[]>`SELECT ${2}::int AS v`,
    ]);
    assert(a[0]?.v === 1 && b[0]?.v === 2, "array transaction returned wrong rows");
  });

  await prisma.$disconnect();
  console.log("All checks passed.");
}

void main();
