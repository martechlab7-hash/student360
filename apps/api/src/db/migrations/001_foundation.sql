-- Student 360 — foundation schema.
-- Tenant isolation is enforced by PostgreSQL Row-Level Security. The runtime role (s360_app)
-- is NOT the table owner and has no BYPASSRLS, so every query only ever sees rows whose
-- tenant_id matches the transaction-local setting app.tenant_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ───────────────────────────── Platform / tenancy ─────────────────────────────
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  settings    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Login needs to resolve a tenant slug before a tenant context exists.
CREATE OR REPLACE FUNCTION resolve_tenant(p_slug text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM tenants WHERE slug = p_slug AND status = 'active'
$$;

CREATE TABLE subscriptions (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  plan        text NOT NULL DEFAULT 'pilot',
  seats       int NOT NULL DEFAULT 1000,
  status      text NOT NULL DEFAULT 'active',
  renews_at   timestamptz
);

CREATE TABLE usage_counters (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  metric      text NOT NULL,
  period      date NOT NULL,
  value       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, metric, period)
);

-- Hierarchy: tenant → campus → department → program → batch → section.
CREATE TABLE org_units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  parent_id   uuid REFERENCES org_units(id) ON DELETE RESTRICT,
  type        text NOT NULL CHECK (type IN ('campus','department','program','batch','section')),
  name        text NOT NULL,
  code        text,
  path        uuid[] NOT NULL DEFAULT '{}',   -- ancestors incl. self, root first
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, type, code)
);
CREATE INDEX org_units_parent_idx ON org_units (tenant_id, parent_id);
CREATE INDEX org_units_path_idx ON org_units USING gin (path);

CREATE OR REPLACE FUNCTION org_units_set_path() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_path uuid[];
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path := ARRAY[NEW.id];
  ELSE
    SELECT path INTO parent_path FROM org_units WHERE id = NEW.parent_id AND tenant_id = NEW.tenant_id;
    IF parent_path IS NULL THEN RAISE EXCEPTION 'parent org unit not found in tenant'; END IF;
    NEW.path := parent_path || NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER org_units_path BEFORE INSERT OR UPDATE OF parent_id ON org_units
  FOR EACH ROW EXECUTE FUNCTION org_units_set_path();

-- ───────────────────────────── Identity & RBAC ─────────────────────────────
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  email           citext NOT NULL,
  full_name       text NOT NULL,
  password_hash   text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled')),
  kind            text NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff','student','guardian','external','platform')),
  mfa_enabled     boolean NOT NULL DEFAULT false,
  mfa_secret_enc  text,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  settings        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE auth_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash  text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  replaced_by   uuid,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (tenant_id, user_id);

-- Global catalogue of permission keys (resource:action). Not tenant data.
CREATE TABLE permissions (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_*]+:[a-z_*]+$'),
  description  text
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  key         text NOT NULL,
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE role_permissions (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key  text NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE role_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type  text NOT NULL CHECK (scope_type IN ('tenant','campus','department','program','batch','section','student')),
  scope_id    uuid NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id, scope_type, scope_id)
);
CREATE INDEX role_assignments_user_idx ON role_assignments (tenant_id, user_id);

-- ───────────────────────────── People ─────────────────────────────
CREATE TABLE students (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  user_id          uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  section_id       uuid NOT NULL REFERENCES org_units(id),
  roll_no          text,
  full_name        text NOT NULL,
  enrollment_year  int,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','graduated','withdrawn')),
  profile          jsonb NOT NULL DEFAULT '{}',   -- personal/academic profile fields (configurable)
  interests        text[] NOT NULL DEFAULT '{}',
  career_goals     text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, roll_no)
);
CREATE INDEX students_section_idx ON students (tenant_id, section_id);
CREATE TRIGGER students_touch BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE guardian_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  guardian_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  relationship   text NOT NULL DEFAULT 'parent',
  status         text NOT NULL DEFAULT 'active',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guardian_user_id, student_id)
);

CREATE TABLE courses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  org_unit_id uuid REFERENCES org_units(id),
  code        text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE course_enrollments (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (course_id, student_id)
);

-- External system identities make integration syncs idempotent (never duplicate students).
CREATE TABLE external_identities (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  system       text NOT NULL,
  entity_type  text NOT NULL,
  external_id  text NOT NULL,
  entity_id    uuid NOT NULL,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, system, entity_type, external_id)
);

-- ───────────────────────────── Audit / outbox / idempotency ─────────────────────────────
CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  actor_user_id  uuid,
  actor_type     text NOT NULL DEFAULT 'user',
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  source         text NOT NULL DEFAULT 'api',
  ip             inet,
  user_agent     text,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (tenant_id, entity_type, entity_id);
CREATE INDEX audit_logs_time_idx ON audit_logs (tenant_id, created_at DESC);

-- Transactional outbox: domain events are written in the same transaction as the change and
-- relayed to the queue by the worker. Modules never call notification/AI services directly.
CREATE TABLE outbox_events (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  type            text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        int NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

CREATE TABLE idempotency_keys (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  user_id          uuid NOT NULL,
  key              text NOT NULL,
  request_hash     text NOT NULL,
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, key)
);

-- ───────────────────────────── Privacy ─────────────────────────────
CREATE TABLE consents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_student_id uuid REFERENCES students(id) ON DELETE CASCADE,
  purpose            text NOT NULL,   -- e.g. ai_processing, guardian_sharing, audio_recording
  granted            boolean NOT NULL,
  policy_version     text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_lookup_idx ON consents (tenant_id, subject_student_id, purpose, created_at DESC);

CREATE TABLE data_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  requester_id       uuid NOT NULL,
  subject_student_id uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('export','delete')),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','processing','completed','rejected')),
  result_ref         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
