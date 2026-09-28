# Security & privacy

## Implemented

| Control | How |
|---|---|
| Tenant isolation | PostgreSQL RLS (forced) on every tenant table; runtime role without BYPASSRLS; CI test asserts coverage |
| Authentication | Argon2id (OWASP params); password policy; uniform error + timing for unknown tenant/user; lockout after 5 failures (15 min) |
| MFA | RFC 6238 TOTP, secret encrypted at rest (AES-256-GCM) |
| Sessions | 15-min JWT access tokens (memory only in the SPA); rotating refresh tokens in an httpOnly, SameSite=Strict cookie scoped to `/api/v1/auth`; **refresh reuse ⇒ revoke all sessions**; server-side session check on every request (logout/revocation is immediate); password change revokes other sessions |
| CSRF | Access tokens are bearer headers (not cookies); the cookie-based refresh requires a custom header that forces a CORS preflight |
| Authorization | Data-driven, scope-aware RBAC; out-of-scope resources return 404; permission keys validated on role edits |
| Input validation / injection | zod on every body/query/param; parameterised SQL only; strict JSON body limit (2 MB) |
| XSS / headers | Helmet (CSP `default-src 'none'` on the API, frame-ancestors none); React escapes by default; no `dangerouslySetInnerHTML` |
| Rate limiting | Global per tenant+user (or IP), stricter on login, MFA, refresh, AI and attendance |
| Secrets | From environment/secret manager; production refuses to start with default secrets; API keys never reach the browser; integration credentials encrypted (`integrations.config_enc`) and never returned |
| Audit | Append-only `audit_logs` (runtime role has no UPDATE/DELETE; trigger blocks edits): logins, failures, MFA, role/permission changes, score overrides, teacher skill overrides, evidence verification, attendance review, config (dimensions, scoring, AI), profile views/changes, guardian views, data requests, imports |
| Untrusted code | Never executed on app/worker hosts; delegated to an isolated Judge0-compatible sandbox with CPU/memory limits and no network |
| Client-side trust | Scores are computed server-side only; submitted `score` fields are ignored; answer keys and hidden tests are stripped from student views; attendance validity is decided server-side |
| Logging hygiene | Authorization, cookies and platform tokens are redacted from logs |

## Privacy

- **Consent** records per purpose (`ai_processing`, `guardian_sharing`, `audio_recording`, …), versioned by policy. Tenants can require AI consent; the gateway enforces it.
- **Purpose limitation / minimisation**: AI prompts carry pseudonymous context (no names, emails, roll numbers).
- **Guardian access** is limited to an understandable summary; interventions, counselling, sensitive dimensions and raw AI output are never shown. Students can restrict guardian sharing via consent.
- **Sensitive dimensions** (well-being) are excluded from growth scores and visible only to authorised staff; never used punitively.
- **Biometrics**: only verified attendance *results* from institutional systems are consumed; no templates stored.
- **Data subject requests**: export/delete requests are recorded, approved by the institution and processed by a worker; tenant offboarding deletes all tenant data (platform-only path).
- **Access logs**: profile and guardian-summary views are audited.

## Operational requirements (deployment)

- TLS everywhere (terminate at the load balancer; HSTS). PostgreSQL and Redis over TLS in production.
- Encryption at rest: managed database/storage encryption plus field encryption for secrets.
- Backups: PITR for PostgreSQL (e.g. 7–35 days), daily snapshots copied cross-region; quarterly restore drills. Redis holds only transient queue state (outbox is the source of truth for events).
- File uploads: pre-signed uploads to tenant-prefixed object storage, content-type allow-list, size limits and malware scanning (e.g. ClamAV/GuardDuty) before files become visible.
- Caching: any cache must key on tenant **and** user for authorization-sensitive data.

## Known gaps (tracked in ROADMAP)

SSO (SAML/OIDC), WebAuthn, per-tenant encryption keys, anomaly detection on security events, penetration testing and a formal DPIA are not yet done.
