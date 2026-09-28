# Student 360

**An AI-powered student growth & development OS for colleges and universities.** It measures growth, not activity.

A teacher sets one objective, e.g. *"Intermediate English speaking"*. The platform gives every student a different task at the right
level, checks that each AI-authored variant has equivalent difficulty, evaluates the work against a versioned rubric, records
evidence with a verification level, updates the student's skill graph, and reports **measured improvement** from baseline to
final assessment.

```
Profile → Baseline → Skill analysis → Personalised tasks → Action → Evidence → Evaluation (AI / system / teacher)
       → Skill update → Growth score (+ evidence confidence) → Gap detection → Next best action → Reassessment → Measured improvement
```

## What's in this repository

| Path | What it is |
|---|---|
| `packages/core` | Pure, dependency-free domain engines: RBAC, difficulty profiles, ability model, evidence trust, growth scoring, progression (modes, remediation, advanced path), attendance tokens and anomaly detection, workflows, neutral-language guard. 30 unit tests. |
| `apps/api` | Fastify modular monolith with PostgreSQL row-level security, BullMQ workers, a transactional outbox and a provider-neutral AI gateway. 52 integration tests against real Postgres. |
| `apps/web` | React app, mobile-first. Homes for student ("Today's Growth"), teacher ("My Students + Actions Required"), parent ("My Child's Progress") and admin ("Institutional Outcomes"), plus the organiser QR screen. |
| `docs/` | [Architecture](docs/ARCHITECTURE.md), [Security & privacy](docs/SECURITY.md), [Requirement status & roadmap](docs/ROADMAP.md). |

## Quick start

Requirements: Node 22+, PostgreSQL 16, Redis 7. You can use `docker compose up -d` for Postgres and Redis.

```bash
npm install
# Database roles + databases (skip if you used docker compose):
psql -U postgres -f apps/api/src/db/bootstrap.sql
psql -U postgres -c "CREATE DATABASE student360 OWNER s360_owner"
psql -U postgres -d student360 -c "CREATE EXTENSION pgcrypto; CREATE EXTENSION citext;"

cp .env.example .env            # then set DATA_ENCRYPTION_KEY etc.
npm run build -w @s360/core
npm run db:migrate
npm run db:seed                 # demo tenant, driven through the real pipeline (mock AI)

npm run dev:api                 # http://localhost:4000  (JOB_MODE=inline runs jobs in-process)
npm run dev:web                 # http://localhost:5173
# Production-style: JOB_MODE=bullmq for the API, plus `npm run dev:worker`
```

Demo sign-in: institution **`demo-college`**, password **`Growth#Demo2026`** for
`student1@demo.edu`, `teacher@demo.edu`, `hod@demo.edu`, `admin@demo.edu`, `events@demo.edu` and `parent@demo.edu`.

To use Claude instead of the offline mock provider, set `AI_DEFAULT_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Admins can also
choose the provider and model per feature at runtime (`PUT /api/v1/config/ai`).

## Tests

```bash
npm run test:unit   # core engines
npm run test:api    # integration: tenant isolation, auth, E2E growth loop, attendance, integrations, AI evaluation safety
```

The API tests need a `student360_test` database (see `.github/workflows/ci.yml`). A k6 load profile lives in `infra/load/`.
