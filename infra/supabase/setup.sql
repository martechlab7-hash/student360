-- Run ONCE in the Supabase SQL editor (as "postgres") BEFORE the first deploy.
-- Replace the password with a long random value and use it in DATABASE_URL on Render.
--
-- The app connects as s360_app, which cannot bypass row-level security, so every query is
-- confined to one institution. Migrations and tenant provisioning use the "postgres" role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's360_app') THEN
    CREATE ROLE s360_app LOGIN PASSWORD 'CHANGE-ME-to-a-long-random-password' NOBYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE postgres TO s360_app;
GRANT USAGE ON SCHEMA public TO s360_app;
-- Supabase installs extensions (citext, pgcrypto) in the "extensions" schema; the app must
-- resolve their types and operators (e.g. case-insensitive email comparison).
GRANT USAGE ON SCHEMA extensions TO s360_app;
ALTER ROLE s360_app SET search_path = public, extensions;

-- Sanity check: expect rolbypassrls = true for postgres and false for s360_app.
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('postgres', 's360_app');
