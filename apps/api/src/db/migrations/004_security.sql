-- Row-Level Security for every tenant-owned table, plus least-privilege grants for the
-- runtime role. Runs last so it covers every table created above.

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())',
      t.table_name);
  END LOOP;
END $$;

-- A tenant can read only its own tenant row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = app_tenant());

-- Audit log is append-only for everyone.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- Runtime role grants (role is created by db/bootstrap.sql or the platform's IaC).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's360_app') THEN
    GRANT USAGE ON SCHEMA public TO s360_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO s360_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO s360_app;
    REVOKE UPDATE, DELETE ON audit_logs FROM s360_app;
    REVOKE INSERT, UPDATE, DELETE ON permissions FROM s360_app;
    REVOKE INSERT, UPDATE, DELETE ON tenants FROM s360_app;
    GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO s360_app;
  END IF;
END $$;

-- Tables created by future migrations inherit the same runtime grants. (RLS must still be
-- enabled explicitly — test/security.test.ts fails the build if any tenant table lacks it.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's360_app') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO s360_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO s360_app;
  END IF;
END $$;
