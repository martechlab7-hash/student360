-- Tenant offboarding (contractual data deletion) must be able to remove audit rows together with
-- the tenant. Only the platform owner role can do this, and only by explicitly opting in within the
-- transaction; the runtime role has no UPDATE/DELETE grant on audit_logs at all.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.tenant_offboarding', true) = 'on' AND current_user <> 's360_app' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;
