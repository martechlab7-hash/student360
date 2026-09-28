# Architecture

## 1. Shape: a modular monolith with hard boundaries

The system is one deployable API plus horizontally scalable workers, not microservices. Boundaries are enforced in code:

- **`@s360/core`** holds the domain rules (scoring, ability model, difficulty, progression, RBAC evaluation, attendance tokens) as
  pure functions with no I/O. They are unit-tested in isolation and never duplicated in the UI.
- **`apps/api/src/services`** holds application services, one per bounded context: tasks, evaluation, growth, recommendations,
  attendance, notifications, mentor, people, tenancy, insights.
- **`apps/api/src/modules`** holds thin HTTP adapters: validation (zod), authorization and a call into a service.
- **Events** connect modules. A service writes a domain event to the **transactional outbox** in the same transaction as its
  state change. The relay moves committed events into BullMQ, and `jobs/relay.ts` is the only place that wires modules together.

A context can be extracted into its own service later (evaluation and AI are the likeliest) without changing its callers,
because they already communicate by events and jobs.

## 2. Multi-tenancy: isolation by the database, not by convention

```
Platform → Tenant → Campus → Department → Program → Batch → Section → Student
```

- Every tenant-owned table has `tenant_id uuid NOT NULL DEFAULT app_tenant()` and a **FORCE ROW LEVEL SECURITY** policy
  `tenant_id = current_setting('app.tenant_id')`.
- The API connects as `s360_app`, which is **not** the table owner and has **NOBYPASSRLS**. Every request runs inside
  `withTenant()`, which opens a transaction and sets `app.tenant_id` (and `app.user_id`) with `set_config(..., true)` so the
  setting is transaction-local. With no context set, queries return zero rows.
- The owner role (`s360_owner`, BYPASSRLS) is used for only three things: migrations, tenant provisioning, and the outbox
  relay. The relay reads events across tenants, then each job re-enters its own tenant through RLS.
- `test/security.test.ts` fails the build if any table with a `tenant_id` column lacks enabled **and** forced RLS. It also checks
  that the runtime role cannot bypass RLS, that cross-tenant reads, writes and updates are impossible, and that API calls
  across tenants return 404.
- **Cache and jobs.** Job payloads always carry `tenantId`. Rate-limit keys are `tenant:user`. Any cache added later must use
  tenant- and user-qualified keys (see SECURITY.md).
- **Object storage** keys are prefixed `tenants/{tenantId}/…`.
- **AI context.** Prompts are built from data read inside the tenant's RLS context and contain only pseudonymous fields.

## 3. RBAC: permissions are data, scopes are hierarchical

- Permission keys have the form `resource:action`, where the actions are `view, create, edit, delete, publish, evaluate, approve,
  export, configure, manage_ai, manage_integrations`. `resource:*` and `*:*` are wildcards.
- Roles are per-tenant bundles of permissions. The defaults (College Admin, HOD, Teacher, Mentor, Placement Officer, Event
  Coordinator, Lab Admin, Counsellor, External Evaluator, Student, Parent…) are seeded as **editable data**.
- A role assignment binds a user to a role **at a scope**: tenant, campus, department, program, batch, section or student.
  Students are granted their role at their own student scope; guardians at their child's.
- `can(principal, permission, target)` checks whether any grant covers the target's ancestry (e.g. a student's section path). List
  endpoints turn the principal's scopes into SQL predicates (`studentScopeFilter`). Business code never checks role names.
- A resource that exists but is out of scope returns **404**, so its existence isn't leaked.

## 4. The growth loop

```
 teacher objective ─► task_template (mode, difficulty profile, rubric vN, target)
                        │ publish → outbox: task.published
                        ▼
              job: generate_assignments ── per student ──►  decideProgression()  (core; deterministic, explained)
                        │                                    │ path: standard / remediation / advanced
                        │                                    ▼
                        │                      AI gateway: task.generate_variant@1.0.0
                        │                      accept only if isEquivalent(target, variant) && topic unused
                        ▼                      else retry → else fall back to teacher content (flagged)
              task_assignment (content, difficulty, rationale "why")
                        │ student submits (Idempotency-Key)   → outbox: submission.created
                        ▼
              job: evaluate  ── auto (MCQ) / sandbox (code) / AI rubric / teacher
                        │  AI: model, prompt version, rubric version stored; scores clamped & totalled server-side;
                        │  low confidence or flagged → needs_review (teacher)
                        ▼ evaluation.finalized
              job: apply ── evidence (verification level) + skill_signals (unique per source → idempotent, override-replaceable)
                        ▼ growth.recalculate (debounced per student)
              job: recalc ── replay signals → student_skills → dimensions → overall + evidence confidence → daily snapshot
                        ▼
              recommendations (rule engine, deduplicated, with rationale) → notifications
```

### Difficulty is measured, not named
Teacher-facing levels (Beginner…Expert) are bands over a 7-axis profile: concept complexity, reasoning steps, prerequisite
knowledge, ambiguity, time pressure, problem complexity and cognitive load. An AI variant must report its profile. It is accepted
only if its composite is within 5 points and no axis drifts by more than 0.2. Planned next step: calibrate against observed item
statistics (success rates per variant) so equivalence is empirically checked, not only self-reported (see ROADMAP).

### Ability model
The model is an Elo/IRT-style update (`core/ability.ts`). Success on harder tasks moves proficiency more. The learning rate
shrinks as confidence grows. Evidence is weighted by verification level: verified 1.0, partially verified 0.6, self-reported
0.25. The recommended difficulty targets roughly a 70% expected success rate. Signals are stored and **replayed**, so every
score is reproducible and can be backfilled (`recalculateStudent(…, asOf)`) after a scoring-config change.

### Progression
- **STANDARDIZED:** identical content for everyone. Required for baseline and final assessments.
- **EQUIVALENT:** different content, same competency and difficulty.
- **ADAPTIVE / PERSONALIZED:** the ability model picks the level, bounded by the teacher's `maxLevelShift`.
- **Remediation:** triggered by 3 consecutive attempts below 50%. It steps down one band, and the prompt targets the
  diagnosed `conceptsMissed` from recent evaluations.
- **Advanced path:** triggered by 3 consecutive attempts at 95% or above. It steps up one band and recommends a project or
  peer mentoring.

### Growth score
Scoring is **configuration, versioned per tenant**. It is layered: skills → dimensions → overall, using dimension weights from
the tenant. Engagement (task completion) is capped at `engagementWeight ≤ 0.4` (default 0.15), so activity alone can't produce a
high score. Sensitive dimensions (well-being) are excluded from the overall score and shown only to authorised staff. Every
snapshot stores its config version and an **evidence confidence** value between 0 and 100.

**Outcome metric:** `GET /growth/improvement` pairs STANDARDIZED baseline and final results per skill. Its response explicitly
states that the pairing shows change, not causation.

## 5. Asynchronous processing
Everything expensive runs as a background job: AI generation, evaluation, sandbox runs, growth recalculation, notifications,
imports, exports and nightly snapshots.

- BullMQ provides retries with exponential backoff; the relay uses `FOR UPDATE SKIP LOCKED`, so multiple workers can run.
- **Every handler is idempotent.** This relies on unique keys (`task_assignments(template, student)`,
  `skill_signals(source, skill)`, `evidence(activity ref)`, `notifications(dedupe_key)`, `external_identities`, `sync_jobs`) and on
  state checks before acting.
- AI calls never hold a database transaction open. The gateway uses short transactions for governance and logging.
- HTTP responses are sent only after COMMIT. The `created()` helper returns the body rather than calling `reply.send()`. This
  was a real bug, caught by the E2E suite.

## 6. AI gateway (`apps/api/src/ai`)
- It exposes a `runPrompt(ctx, name, vars)` interface. The provider is resolved per tenant and per feature from
  `ai_model_configs`.
- Two providers exist: `anthropic`, which uses structured outputs and server-side refusal fallbacks where supported, and
  `mock`, which is deterministic and powers offline dev, CI and golden tests. A new vendor only needs to implement
  `AIProvider`.
- Prompts are versioned (`key@version`) and include rubrics. Rubric versions are stored on templates and evaluations.
- **Governance** checks the tenant AI switch, per-student consent (if the policy requires it) and a daily quota.
- Every call is logged to `ai_interactions`: provider, model, prompt version, token counts, latency, cost, status and retries.
  Logs are written in a separate transaction, so failures are recorded too.
- Outputs are re-validated with zod. Model arithmetic is never trusted: the server clamps each criterion and computes the total.

## 7. Evidence and verification
The verification levels are **VERIFIED**, **PARTIALLY_VERIFIED** and **SELF_REPORTED**. Each source gets a default level:

| Source | Default level |
|---|---|
| auto-graded and sandbox results | verified |
| teacher evaluation | verified |
| clean QR attendance | verified |
| AI-only evaluation | partially verified |
| flagged attendance | partially verified |
| certificates | partially verified |
| student-submitted | self-reported |

Any change of level requires `evidence:approve`, never on one's own evidence, and appends to `evidence_verifications`.

## 8. Attendance anti-cheating
- The organiser screen shows a QR code encoding a URL with an **HMAC token bound to the session and a 20-second window**. A
  code is valid for about 40 seconds in total, including one window of skew.
- Check-in requires an authenticated student, a valid token, and runs serialised per session.
- Signals checked: registration, time window, duplicate check-in, **shared device** (device id hashed per tenant),
  overlapping-session check-in and IP bursts.
- Anomalies set `status = flagged` with the flag codes. The student is told the check-in is "pending organiser confirmation";
  nobody is auto-accused. The organiser's review upgrades or downgrades the evidence.
- Biometric and RFID integrations submit a **verified result** (method `biometric_system` / `attendance_api`). No raw biometric
  data is stored.

## 9. Data model (key tables)
| Area | Tables |
|---|---|
| Tenancy | `tenants`, `tenant_policies`, `subscriptions`, `usage_counters` |
| Organisation | `org_units` (typed, materialised `path`), `courses`, `course_enrollments` |
| Identity | `users`, `auth_sessions`, `permissions`, `roles`, `role_permissions`, `role_assignments` |
| People | `students`, `guardian_links`, `external_identities` |
| Skills | `growth_dimensions`, `scoring_configs`, `skills` (hierarchical), `student_skills`, `skill_signals` |
| Tasks | `task_templates`, `task_assignments`, `task_submissions`, `evaluations` |
| Evidence and growth | `evidence`, `evidence_verifications`, `growth_snapshots`, `recommendations`, `interventions`, `intervention_events`, `achievements` |
| Events | `events`, `event_sessions`, `event_registrations`, `event_attendance` |
| Projects and content | `projects`, `project_members`, `content_items` |
| AI | `ai_model_configs`, `ai_interactions`, `ai_conversations`, `ai_messages` |
| Platform | `notifications`, `outbox_events`, `idempotency_keys`, `integrations`, `sync_jobs`, `webhooks`, `audit_logs`, `consents`, `data_requests` |

Assessments are task templates with `assessment_kind` (baseline, formative or final) and STANDARDIZED mode. A question bank is
`content_items` of kind `question`. This keeps a single engine rather than parallel ones. Indexes follow the actual query
paths: student + status + due date, section path (GIN), review queues (partial indexes) and audit by entity.

## 10. API conventions
- All routes live under `/api/v1`.
- Every route is private unless it opts out with `config.public`.
- Validation uses zod. The error envelope is `{ error: { code, message, details, requestId } }`.
- Lists use keyset pagination (`cursor`, `limit`).
- `Idempotency-Key` is supported on submissions: the first response is stored and replayed, and reusing a key with a different
  body returns 422.
- Rate limits apply globally per tenant and user, with stricter limits on login, MFA, refresh, AI and check-in.

## 11. Scaling notes
- The API is stateless (JWT plus a per-request session check), so it scales horizontally behind a load balancer.
- Workers scale independently; set `WORKER_CONCURRENCY` per instance.
- Dashboards read **snapshots**; nothing recomputes institution-wide scores per request. Growth recalculation is debounced
  per student.
- For hot paths such as the student home and teacher home, add read replicas and short-TTL tenant+user-keyed caches.
  Partition `ai_interactions`, `audit_logs` and `skill_signals` by month when they grow.
