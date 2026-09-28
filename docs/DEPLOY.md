# Deploying for free: Supabase + Render + Vercel

```
Browser ──► Vercel (web app)  ──/api/* rewrite──►  Render (API + background jobs)  ──►  Supabase (PostgreSQL)
```

The browser only ever talks to your Vercel domain; Vercel forwards `/api/*` to Render. Keeping one origin is what
lets the secure, same-site login cookie work.

**Free-tier trade-offs:** Render sleeps the API after ~15 minutes idle (the first request then takes ~30–60 s —
if the page shows an error, wait a minute and reload). Supabase pauses a free project after ~7 days without
activity (resume it from the dashboard). Background jobs run inside the single API process, which is fine for a
demo or pilot. The upgrade path is a paid Render instance plus a separate worker (`JOB_MODE=bullmq` + Redis);
no code changes.

---

## 1. Supabase (database)

1. Create a project at supabase.com. **Region: Southeast Asia (Singapore)** — the same region as the Render
   service in `render.yaml` (a cross-region database makes every request slow). Save the database password.
2. **SQL Editor** → paste `infra/supabase/setup.sql`, replace `CHANGE-ME-…` with a long random password
   (letters and digits only avoids URL-encoding trouble), **Run**. The last query should show
   `postgres | true` and `s360_app | false`.
3. **Turn off the Data API** (the app does not use it): *Project Settings → Data API* → disable it, or remove
   `public` from the exposed schemas. (Migration `007_hosted_postgres.sql` also revokes its table access.)
4. **Connect** (top bar) → *Connection pooler*. You need two connection strings:

   | Render variable | Pooler mode | User | Example |
   |---|---|---|---|
   | `DATABASE_URL` | **Transaction** (port 6543) | `s360_app.<project-ref>` | `postgresql://s360_app.abcd1234:APP_PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres` |
   | `DATABASE_ADMIN_URL` | **Session** (port 5432) | `postgres.<project-ref>` | `postgresql://postgres.abcd1234:DB_PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` |

   Use the pooler host shown in your dashboard; don't add `?sslmode=…` (TLS is configured separately).
5. *Project Settings → Database → SSL Configuration* → **Download certificate**. Open the file; you'll paste its
   full contents (including the `BEGIN/END CERTIFICATE` lines) into Render.

## 2. Render (API)

1. render.com → **New → Blueprint** → connect this GitHub repo → it reads `render.yaml`.
   (If the branch isn't `main` yet, pick the branch that contains `render.yaml`.)
2. Fill in the variables Render asks for:
   - `DATABASE_URL`, `DATABASE_ADMIN_URL` — from step 1.4
   - `DATABASE_CA_CERT` — the certificate contents from step 1.5
   - `SEED_DEMO_PASSWORD` — the password you want for the demo accounts (≥ 12 characters, e.g. `Welcome#Demo2026!`;
     it must not contain the account name, e.g. "student", "teacher", "admin")
   - `CORS_ORIGINS` — your Vercel URL, e.g. `https://student360.vercel.app`
   - `ANTHROPIC_API_KEY` — leave empty to use the free built-in mock AI
3. **Apply**. The first boot runs the database migrations, starts the server, then creates the demo institution in
   the background (watch the *Logs* tab for `Seeded tenant "demo-college"`).
4. Check `https://<your-service>.onrender.com/api/v1/health` returns `{"status":"ok"}`.

   If the logs show a certificate error, double-check `DATABASE_CA_CERT`. As a last resort set
   `DATABASE_SSL=no-verify` (still encrypted, but the server's identity is not verified).

## 3. Vercel (web)

1. In `vercel.json`, the first rewrite points to `https://student360-api.onrender.com`. If Render gave your
   service a different URL, change that line, commit and push.
2. Redeploy on Vercel (the project settings can stay default — `vercel.json` sets the build and output).
3. Open your Vercel URL → sign in with institution **`demo-college`**, e.g. `student1@demo.edu`,
   `teacher@demo.edu`, `admin@demo.edu` or `parent@demo.edu`, and your `SEED_DEMO_PASSWORD`.

## 4. Afterwards

- **Stop re-seeding:** set `SEED_DEMO_ON_START=false` on Render once you no longer want the demo data
  (it never overwrites an existing tenant either way).
- **Your own institution:** `POST /api/v1/platform/tenants` with header `x-platform-token: <PLATFORM_ADMIN_TOKEN>`
  (Render generated it; see the service's *Environment* tab):
  `{"slug":"my-college","name":"My College","admin":{"email":"...","fullName":"...","password":"..."}}`.
- **Real AI:** set `AI_DEFAULT_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` on Render (usage is billed by Anthropic).
- **Avoid cold starts:** a free uptime pinger (e.g. cron-job.org) hitting `/api/v1/health` every 10 minutes keeps it
  awake; one always-on service fits inside Render's 750 free hours a month.
