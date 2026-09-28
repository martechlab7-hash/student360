# Requirement status & roadmap

Legend: ✅ implemented and tested · 🟡 implemented, partial · ⬜ designed-for, not built yet.

## MVP scope (spec §57)

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Multi-tenancy | ✅ | RLS on every table; provisioning; offboarding |
| 2 | Authentication / RBAC | ✅ | Argon2id, TOTP MFA, rotating refresh, scoped data-driven RBAC. SSO ⬜ |
| 3 | Student 360 profile | 🟡 | Profile, skills, evidence, events, projects, interventions, growth. Academic records (marks/attendance) arrive via integrations ⬜ |
| 4 | Teacher dashboard | ✅ | Classes, pending evaluations, neutral insights, skill gaps, interventions |
| 5 | Growth Task Engine | ✅ | 23 task types via registry; 4 modes; attempts, due dates, passing score, evidence, teacher review |
| 6 | Daily 5–10 micro tasks | 🟡 | "Today" view with streaks; recurring/daily auto-scheduling from journeys ⬜ |
| 7 | Evidence engine | ✅ | Levels, sources, history, review queue, self-reports |
| 8 | AI personalised task generation | ✅ | Per-student variants; difficulty equivalence + topic-uniqueness gate; fallback |
| 9 | AI evaluation | ✅ | Versioned rubric prompts; clamping; confidence routing; teacher override with audit |
| 10 | English speaking coach | 🟡 | Transcript-based evaluation (browser speech recognition / STT). Audio-level pronunciation analysis needs an STT/pronunciation provider ⬜ |
| 11 | Aptitude engine | 🟡 | MCQ/quiz auto-grading; aptitude skills. Item bank & calibrated item difficulty ⬜ |
| 12 | Basic coding challenges | 🟡 | Coding/SQL task types, hidden tests, sandbox runner interface (Judge0). Sandbox deployment is infra ⬜ |
| 13 | Skill graph | ✅ | Hierarchical skills, roll-up, proficiency/confidence/velocity/difficulty/override |
| 14 | Growth scoring | ✅ | Configurable, versioned, evidence confidence, sensitive-dimension exclusion |
| 15 | Growth trends | ✅ | Daily snapshots, 28-day delta/velocity, backfill with `asOf` |
| 16 | AI student mentor | ✅ | Context-aware, returns actions with reasons (persisted as recommendations); mock interviewer |
| 17 | Events + QR attendance | ✅ | Rotating HMAC QR, anomaly flags, organiser review |
| 18 | Parent dashboard | ✅ | Summary with privacy filtering and consent |
| 19 | Audit logging | ✅ | Append-only, broad coverage |
| 20 | Analytics | 🟡 | Student/section/department/tenant aggregates, baseline→final improvement. Program/batch drill-downs in UI, cohort comparisons ⬜ |

## Beyond MVP (spec phases 6–12)

| Area | Status | Next step |
|---|---|---|
| Remediation / advanced paths | ✅ engine · ⬜ missions | Mission/journey instances that walk `REMEDIATION_STEPS` automatically |
| Development journeys (visual workflow) | ⬜ | Journey definition JSON (trigger → steps → branch on outcome) executed by the job system; visual builder later |
| Item calibration | ⬜ | Track per-variant success rates; empirically validate equivalence; retire drifting variants |
| Interventions | ✅ | State machine + baseline/outcome measurement |
| Career platform | 🟡 | Career dimension, interview practice. Resume analysis, company-specific tracks ⬜ |
| Projects | 🟡 | Create, members, faculty evaluation → verified evidence + skill signals. AI skill extraction with review ⬜ |
| Virtual labs | ⬜ | Lab task type exists; simulation engines (e.g. PhET, Falstad, OpenModelica) embedded via a lab adapter |
| Content system | 🟡 | AI transform (summary/quiz/micro tasks/learning path) into review-pending drafts. Content library UI, file storage adapter ⬜ |
| Notifications | 🟡 | Event-driven in-app; channel adapter interface for email/push/SMS/WhatsApp (providers not wired) |
| Integration hub | 🟡 | Idempotent student import (API/CSV-shaped). ERP/LMS/attendance connectors, webhooks delivery, SFTP scheduling ⬜ |
| Observability | 🟡 | Structured logs with request ids, admin health (queue, outbox lag, AI latency/cost/failures, security events). OpenTelemetry tracing + metrics export ⬜ |
| Billing / usage | 🟡 | Subscriptions + usage counters (AI calls). Metering UI & billing provider ⬜ |
| Gamification | 🟡 | Streaks, achievements table, milestones. No public ranking (by design) |

## Testing status

- Unit: core engines (30 tests).
- Integration/E2E (API + Postgres, 52 tests): tenant isolation & RLS coverage, auth (lockout, refresh reuse, MFA), RBAC scoping, the full
  task → submission → evaluation → evidence → growth loop, overrides, idempotency, baseline/final improvement, attendance anti-cheating,
  integration idempotency, interventions, AI governance (consent/switch), AI failure routing, rubric consistency and clamping.
- Load: k6 profile in `infra/load/` (not yet run against a production-sized environment).
- Not yet: browser E2E in CI, AI golden datasets against a real model, penetration test.
