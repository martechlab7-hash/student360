-- Tenant-editable institutional policies (the tenants row itself is platform-owned and
-- read-only to the runtime role).
CREATE TABLE tenant_policies (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  ai          jsonb NOT NULL DEFAULT '{"enabled": true, "requireConsent": false}',
  privacy     jsonb NOT NULL DEFAULT '{"guardianCanSeeEvaluations": false, "retentionDays": 1825}',
  attendance  jsonb NOT NULL DEFAULT '{"tokenWindowSeconds": 20}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_policies USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
INSERT INTO tenant_policies (tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;
