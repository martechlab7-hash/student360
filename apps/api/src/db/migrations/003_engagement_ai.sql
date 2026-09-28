-- Events & attendance, projects, content, AI governance, notifications, integrations.

CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  name          text NOT NULL,
  organizer     text NOT NULL,
  description   text,
  venue         text,
  category      text NOT NULL DEFAULT 'academic',  -- academic | technical | cultural | sports | social | career …
  capacity      int,
  eligibility   jsonb NOT NULL DEFAULT '{}',       -- {orgUnitIds:[], years:[]}
  dimension_id  uuid REFERENCES growth_dimensions(id),
  skill_ids     uuid[] NOT NULL DEFAULT '{}',
  registration_required boolean NOT NULL DEFAULT true,
  certificate   boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','completed','cancelled')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  event_id           uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title              text,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL CHECK (ends_at > starts_at),
  grace_minutes      int NOT NULL DEFAULT 15,
  attendance_secret  text NOT NULL,        -- per-session HMAC key, encrypted at rest
  check_out_required boolean NOT NULL DEFAULT false
);

CREATE TABLE event_registrations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'participant',  -- participant | organiser | volunteer | performer | winner …
  status      text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','waitlisted','cancelled')),
  outcome     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, student_id)
);

CREATE TABLE event_attendance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  session_id    uuid NOT NULL REFERENCES event_sessions(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  method        text NOT NULL CHECK (method IN ('dynamic_qr','college_id','rfid','attendance_api','biometric_system','manual')),
  check_in_at   timestamptz NOT NULL DEFAULT now(),
  check_out_at  timestamptz,
  device_hash   text,
  ip            inet,
  token_window  bigint,
  status        text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','flagged','rejected')),
  flags         text[] NOT NULL DEFAULT '{}',
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  review_note   text,
  UNIQUE (session_id, student_id)
);
CREATE INDEX event_attendance_device_idx ON event_attendance (tenant_id, session_id, device_hash);
CREATE INDEX event_attendance_flagged_idx ON event_attendance (tenant_id, status) WHERE status = 'flagged';

CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  title        text NOT NULL,
  problem      text,
  description  text,
  repo_url     text,
  docs_url     text,
  demo_url     text,
  skill_ids    uuid[] NOT NULL DEFAULT '{}',
  milestones   jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('idea','active','submitted','evaluated','archived')),
  outcome      text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, student_id)
);

CREATE TABLE content_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  kind               text NOT NULL,   -- note | pdf | video | question | course | lab | template | learning_path
  title              text NOT NULL,
  body               jsonb NOT NULL DEFAULT '{}',
  file_ref           text,
  skill_ids          uuid[] NOT NULL DEFAULT '{}',
  derived_from_id    uuid REFERENCES content_items(id),
  ai_generated       boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','published','archived')),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── AI governance ─────────────────────────────
CREATE TABLE ai_model_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  feature     text NOT NULL,          -- '*' or task_generation | evaluation | mentor | speaking | interview | teacher_assistant
  provider    text NOT NULL,
  model       text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  params      jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, feature)
);

CREATE TABLE ai_interactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  user_id         uuid,
  feature         text NOT NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  prompt_key      text NOT NULL,
  prompt_version  text NOT NULL,
  input_ref       text,
  request_hash    text NOT NULL,
  output          jsonb,
  input_tokens    int,
  output_tokens   int,
  latency_ms      int,
  cost_usd        numeric(12,6),
  status          text NOT NULL CHECK (status IN ('succeeded','failed','refused','invalid_output')),
  error           text,
  retries         int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_interactions_usage_idx ON ai_interactions (tenant_id, created_at DESC, feature);

CREATE TABLE ai_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  student_id  uuid REFERENCES students(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('mentor','speaking','interview','teacher_assistant')),
  meta        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  conversation_id  uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user','assistant')),
  content          text NOT NULL,
  meta             jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_messages_conv_idx ON ai_messages (conversation_id, created_at);

-- ───────────────────────────── Notifications ─────────────────────────────
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('in_app','push','email','sms','whatsapp')),
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  data        jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','read')),
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, channel, dedupe_key)
);
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id, created_at DESC);

-- ───────────────────────────── Integrations ─────────────────────────────
CREATE TABLE integrations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  kind        text NOT NULL,   -- erp | sis | lms | attendance | biometric | exam | placement | sso | csv | sftp
  name        text NOT NULL,
  config_enc  text,            -- encrypted JSON (credentials never returned by the API)
  status      text NOT NULL DEFAULT 'active',
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  integration_id   uuid REFERENCES integrations(id) ON DELETE SET NULL,
  kind             text NOT NULL,
  idempotency_key  text NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','partial')),
  stats            jsonb NOT NULL DEFAULT '{}',
  error            text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  url         text NOT NULL CHECK (url ~ '^https://'),
  secret_enc  text NOT NULL,
  events      text[] NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
