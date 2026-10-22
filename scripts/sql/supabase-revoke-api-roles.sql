-- Removes Supabase Data API role access to the public schema. CRIA PING only
-- talks to Postgres directly (Prisma, as postgres), so anon, authenticated and
-- service_role never need these grants. Idempotent: safe to run again.
-- Run only through `tsx scripts/db-guard.ts harden` (production-database
-- workflow), which checks the target project first.
BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'Supabase API roles not found: refusing to run on this database';
  END IF;
END $$;

-- Objects that already exist.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, service_role, PUBLIC;

-- Objects created later by postgres (every Prisma migration).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role, PUBLIC;
-- Schema-level defaults only add to the global ones, and the built-in global
-- default gives EXECUTE on new functions to PUBLIC. Remove it for postgres.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
