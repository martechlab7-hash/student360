-- Skills, dimensions, tasks, evidence, evaluation and growth.

CREATE TABLE growth_dimensions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  key         text NOT NULL,
  name        text NOT NULL,
  weight      numeric(6,2) NOT NULL DEFAULT 1 CHECK (weight >= 0),
  enabled     boolean NOT NULL DEFAULT true,
  sensitive   boolean NOT NULL DEFAULT false,
  sort        int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, key)
);

CREATE TABLE scoring_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  version     int NOT NULL,
  config      jsonb NOT NULL,
  active      boolean NOT NULL DEFAULT false,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);
CREATE UNIQUE INDEX scoring_configs_one_active ON scoring_configs (tenant_id) WHERE active;

CREATE TABLE skills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  parent_id     uuid REFERENCES skills(id) ON DELETE RESTRICT,
  dimension_id  uuid NOT NULL REFERENCES growth_dimensions(id),
  key           text NOT NULL,
  name          text NOT NULL,
  description   text,
  weight        numeric(6,2) NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, key)
);
CREATE INDEX skills_parent_idx ON skills (tenant_id, parent_id);

CREATE TABLE student_skills (
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  student_id             uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  skill_id               uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  proficiency            numeric(5,1) NOT NULL DEFAULT 0,
  confidence             numeric(4,3) NOT NULL DEFAULT 0,
  evidence_count         int NOT NULL DEFAULT 0,
  velocity               numeric(6,1) NOT NULL DEFAULT 0,
  recent                 jsonb NOT NULL DEFAULT '[]',
  last_assessed_at       timestamptz,
  current_difficulty     text,
  recommended_difficulty text,
  teacher_override       jsonb,      -- {proficiency, reason, by, at}
  ai_recommendation      text,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, skill_id)
);
CREATE INDEX student_skills_skill_idx ON student_skills (tenant_id, skill_id, proficiency);

-- Every signal that moved a skill; replayable, and unique per source so retries are idempotent.
CREATE TABLE skill_signals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  student_id    uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  skill_id      uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  source_type   text NOT NULL,
  source_id     uuid NOT NULL,
  performance   numeric(5,4) NOT NULL CHECK (performance BETWEEN 0 AND 1),
  difficulty    numeric(5,1) NOT NULL,
  verification  text NOT NULL CHECK (verification IN ('VERIFIED','PARTIALLY_VERIFIED','SELF_REPORTED')),
  weight        numeric(5,2) NOT NULL DEFAULT 1,
  occurred_at   timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, skill_id)
);
CREATE INDEX skill_signals_student_idx ON skill_signals (tenant_id, student_id, skill_id, occurred_at);

-- ───────────────────────────── Tasks ─────────────────────────────
CREATE TABLE task_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  type                text NOT NULL,
  title               text NOT NULL,
  objective           text NOT NULL,
  instructions        text,
  content             jsonb NOT NULL DEFAULT '{}',  -- type-specific base content (questions, starter code …)
  topic               text,
  dimension_id        uuid REFERENCES growth_dimensions(id),
  skill_ids           uuid[] NOT NULL DEFAULT '{}',
  difficulty_level    text NOT NULL CHECK (difficulty_level IN ('beginner','basic','intermediate','advanced','expert')),
  difficulty_profile  jsonb NOT NULL,
  mode                text NOT NULL CHECK (mode IN ('STANDARDIZED','EQUIVALENT','ADAPTIVE','PERSONALIZED')),
  config              jsonb NOT NULL DEFAULT '{}',  -- attempts, passing score, evidence req., evaluation, durations, adaptive …
  rubric              jsonb,
  rubric_version      int NOT NULL DEFAULT 1,
  assessment_kind     text CHECK (assessment_kind IN ('baseline','formative','final')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','published','archived')),
  source              text NOT NULL DEFAULT 'teacher' CHECK (source IN ('teacher','ai','system','journey')),
  target              jsonb NOT NULL DEFAULT '{}',  -- {sectionIds:[], studentIds:[]}
  start_at            timestamptz,
  due_at              timestamptz,
  created_by          uuid,
  approved_by         uuid,
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_templates_status_idx ON task_templates (tenant_id, status, created_at DESC);
CREATE TRIGGER task_templates_touch BEFORE UPDATE ON task_templates FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE task_assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  template_id         uuid NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  student_id          uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  content             jsonb,          -- the personalised prompt/variant actually shown
  difficulty_level    text NOT NULL,
  difficulty_profile  jsonb NOT NULL,
  path                text NOT NULL DEFAULT 'standard' CHECK (path IN ('standard','remediation','advanced')),
  rationale           text NOT NULL,  -- "Why am I getting this task?"
  status              text NOT NULL DEFAULT 'pending_generation',
  generation          jsonb NOT NULL DEFAULT '{}',  -- ai interaction ref, equivalence check, fallback info
  attempts_used       int NOT NULL DEFAULT 0,
  start_at            timestamptz,
  due_at              timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, student_id)
);
CREATE INDEX task_assignments_student_idx ON task_assignments (tenant_id, student_id, status, due_at);
CREATE TRIGGER task_assignments_touch BEFORE UPDATE ON task_assignments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE task_submissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  assignment_id    uuid NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attempt_no       int NOT NULL,
  payload          jsonb NOT NULL,
  file_refs        jsonb NOT NULL DEFAULT '[]',
  status           text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','evaluating','evaluated','needs_review','failed')),
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, attempt_no)
);
CREATE INDEX task_submissions_status_idx ON task_submissions (tenant_id, status, submitted_at);

CREATE TABLE evaluations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  submission_id       uuid NOT NULL REFERENCES task_submissions(id) ON DELETE CASCADE,
  evaluator_type      text NOT NULL CHECK (evaluator_type IN ('auto','ai','teacher','sandbox','system')),
  evaluator_user_id   uuid,
  ai_interaction_id   uuid,
  model               text,
  prompt_version      text,
  rubric              jsonb,
  rubric_version      int,
  input_ref           text,
  output              jsonb NOT NULL DEFAULT '{}',
  score               numeric(6,2),
  max_score           numeric(6,2) NOT NULL DEFAULT 100,
  criteria            jsonb NOT NULL DEFAULT '[]',
  status              text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','needs_review')),
  is_final            boolean NOT NULL DEFAULT false,
  overrides_id        uuid REFERENCES evaluations(id),
  override_reason     text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX evaluations_one_final ON evaluations (submission_id) WHERE is_final;
CREATE INDEX evaluations_review_idx ON evaluations (tenant_id, status, created_at);

-- ───────────────────────────── Evidence ─────────────────────────────
CREATE TABLE evidence (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  student_id          uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  source              text NOT NULL,
  activity_type       text NOT NULL,
  activity_ref_type   text,
  activity_ref_id     uuid,
  title               text NOT NULL,
  description         text,
  data                jsonb NOT NULL DEFAULT '{}',
  file_ref            text,
  dimension_id        uuid REFERENCES growth_dimensions(id),
  skill_ids           uuid[] NOT NULL DEFAULT '{}',
  verification_level  text NOT NULL CHECK (verification_level IN ('VERIFIED','PARTIALLY_VERIFIED','SELF_REPORTED')),
  verified_by         uuid,
  verified_at         timestamptz,
  confidence          numeric(4,3) NOT NULL DEFAULT 0.5,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX evidence_activity_unique ON evidence (tenant_id, student_id, activity_ref_type, activity_ref_id)
  WHERE activity_ref_id IS NOT NULL;
CREATE INDEX evidence_student_idx ON evidence (tenant_id, student_id, occurred_at DESC);
CREATE INDEX evidence_review_idx ON evidence (tenant_id, verification_level) WHERE verification_level <> 'VERIFIED';

CREATE TABLE evidence_verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  evidence_id  uuid NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  from_level   text NOT NULL,
  to_level     text NOT NULL,
  actor_id     uuid NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Growth ─────────────────────────────
CREATE TABLE growth_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  student_id           uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  snapshot_date        date NOT NULL,
  overall              numeric(5,1),
  evidence_confidence  int NOT NULL,
  dimensions           jsonb NOT NULL,
  config_version       int NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, snapshot_date)
);
CREATE INDEX growth_snapshots_idx ON growth_snapshots (tenant_id, snapshot_date, student_id);

CREATE TABLE recommendations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  kind        text NOT NULL,       -- practice | assessment | event | project | mentoring | career …
  title       text NOT NULL,
  body        text,
  action      jsonb NOT NULL DEFAULT '{}',
  rationale   text NOT NULL,       -- AI/system must explain why
  source      text NOT NULL CHECK (source IN ('rule','ai','teacher','journey')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed','done','expired')),
  priority    int NOT NULL DEFAULT 50,
  dedupe_key  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);
CREATE UNIQUE INDEX recommendations_dedupe ON recommendations (tenant_id, student_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'open';
CREATE INDEX recommendations_student_idx ON recommendations (tenant_id, student_id, status, priority DESC);

CREATE TABLE interventions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  student_id   uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('remedial_plan','mentoring','additional_practice','communication_mission','technical_mission','parent_communication','counselling_referral')),
  title        text NOT NULL,
  goal         text NOT NULL,
  skill_id     uuid REFERENCES skills(id),
  state        text NOT NULL DEFAULT 'created',
  owner_id     uuid NOT NULL,
  assignee_id  uuid,
  baseline     jsonb,      -- {score, at}
  outcome      jsonb,      -- {score, at, improvement, note}
  due_at       timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interventions_student_idx ON interventions (tenant_id, student_id, state);
CREATE TRIGGER interventions_touch BEFORE UPDATE ON interventions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE intervention_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  intervention_id  uuid NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
  from_state       text,
  to_state         text NOT NULL,
  actor_id         uuid,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE achievements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT app_tenant(),
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('badge','milestone','streak','award','certificate')),
  key         text NOT NULL,
  title       text NOT NULL,
  evidence_id uuid REFERENCES evidence(id),
  awarded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, kind, key)
);
