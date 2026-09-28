-- Local/dev bootstrap (run as a PostgreSQL superuser). In production, roles are provisioned by
-- infrastructure-as-code and passwords come from the secrets manager.
--   s360_owner : owns the schema, BYPASSRLS. Used ONLY for migrations, tenant provisioning and
--                the outbox relay (which re-enters each tenant through RLS as s360_app).
--   s360_app   : runtime role, NOBYPASSRLS — every tenant query goes through RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's360_owner') THEN
    CREATE ROLE s360_owner LOGIN PASSWORD 's360_owner_dev' BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's360_app') THEN
    CREATE ROLE s360_app LOGIN PASSWORD 's360_app_dev' NOBYPASSRLS;
  END IF;
END $$;
