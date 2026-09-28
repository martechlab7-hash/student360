import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { dummyHash, hashPassword, passwordPolicyErrors, verifyPassword } from '../auth/passwords.js';
import { signAccessToken, signMfaChallenge, verifyToken } from '../auth/tokens.js';
import { config } from '../config.js';
import { appPool, one, withTenant, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import { actor, parse, tx, perMinute } from '../http/context.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REFRESH_COOKIE = 's360_rt';

async function issueSession(db: Db, reply: FastifyReply, user: { id: string; kind: string }, tenantId: string, ip: string, ua?: string, native = false) {
  const secret = randomToken(32);
  const s = await one<{ id: string }>(db,
    `INSERT INTO auth_sessions (user_id, refresh_hash, expires_at, ip, user_agent) VALUES ($1,$2, now() + make_interval(days => $3), $4, $5) RETURNING id`,
    [user.id, sha256(secret), config.REFRESH_TOKEN_TTL_DAYS, ip, ua ?? null]);
  const refreshToken = `${tenantId}.${s!.id}.${secret}`;
  const accessToken = await signAccessToken({ sub: user.id, tid: tenantId, sid: s!.id, kind: user.kind });
  reply.setCookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict', path: '/api/v1/auth', maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86400,
  });
  return { accessToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, ...(native ? { refreshToken } : {}) };
}

export async function authRoutes(app: FastifyInstance) {
  const Login = z.object({ tenant: z.string().min(2).max(63), email: z.string().email().max(320), password: z.string().min(1).max(256) });

  app.post('/auth/login', { config: { public: true, rateLimit: perMinute(10) } }, async (req, reply) => {
    const body = parse(Login, req.body);
    // SECURITY DEFINER lookup: the only tenant data readable without a tenant context is slug → id.
    const tenantId = (await appPool.query<{ id: string | null }>(`SELECT resolve_tenant($1) AS id`, [body.tenant.toLowerCase()])).rows[0]?.id;
    const fail = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid institution, email or password');
    if (!tenantId) { await verifyPassword(await dummyHash(), body.password); throw fail(); }

    // Failure bookkeeping (counter, lockout, audit) must COMMIT, so the transaction returns an
    // outcome and we throw only after it has completed.
    const outcome = await withTenant({ tenantId }, async (db) => {
      const u = await one<any>(db, `SELECT id, kind, status, password_hash, mfa_enabled, failed_logins, locked_until FROM users WHERE email = $1`, [body.email]);
      if (!u || !u.password_hash || u.status !== 'active') { await verifyPassword(await dummyHash(), body.password); return { error: fail() }; }
      if (u.locked_until && new Date(u.locked_until) > new Date()) {
        return { error: new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.') };
      }
      if (!(await verifyPassword(u.password_hash, body.password))) {
        await db.query(
          `UPDATE users SET failed_logins = failed_logins + 1,
                  locked_until = CASE WHEN failed_logins + 1 >= $2::int THEN now() + make_interval(mins => $3::int) END WHERE id = $1`,
          [u.id, MAX_FAILED, LOCK_MINUTES]);
        await audit(db, { ...actor(req), userId: u.id }, { action: 'auth.login_failed', entityType: 'user', entityId: u.id, source: 'auth' });
        return { error: fail() };
      }
      await db.query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [u.id]);
      if (u.mfa_enabled) return { ok: { mfaRequired: true, mfaToken: await signMfaChallenge(u.id, tenantId) } };
      await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
      await audit(db, { ...actor(req), userId: u.id }, { action: 'auth.login', entityType: 'user', entityId: u.id, source: 'auth' });
      return { ok: await issueSession(db, reply, u, tenantId, req.ip, req.headers['user-agent'], req.headers['x-client-type'] === 'native') };
    });
    if (outcome.error) throw outcome.error;
    return outcome.ok;
  });

  app.post('/auth/mfa/verify', { config: { public: true, rateLimit: perMinute(10) } }, async (req, reply) => {
    const body = parse(z.object({ mfaToken: z.string(), code: z.string().length(6) }), req.body);
    const claims = await verifyToken(body.mfaToken, 'mfa');
    const outcome = await withTenant({ tenantId: claims.tid }, async (db) => {
      const u = await one<any>(db, `SELECT id, kind, mfa_secret_enc FROM users WHERE id = $1 AND status = 'active' AND mfa_enabled`, [claims.sub]);
      if (!u || !verifyTotp(decrypt(u.mfa_secret_enc), body.code)) {
        await audit(db, { ...actor(req), userId: claims.sub }, { action: 'auth.mfa_failed', entityType: 'user', entityId: claims.sub, source: 'auth' });
        return { error: unauthorized('Invalid verification code') };
      }
      await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
      await audit(db, { ...actor(req), userId: u.id }, { action: 'auth.login', entityType: 'user', entityId: u.id, after: { mfa: true }, source: 'auth' });
      return { ok: await issueSession(db, reply, u, claims.tid, req.ip, req.headers['user-agent'], req.headers['x-client-type'] === 'native') };
    });
    if (outcome.error) throw outcome.error;
    return outcome.ok;
  });

  // Refresh-token rotation with reuse detection: presenting a revoked token revokes every session of that user.
  app.post('/auth/refresh', { config: { public: true, rateLimit: perMinute(30) } }, async (req, reply) => {
    // Custom header forces a CORS preflight, so a cross-site form cannot trigger a refresh (CSRF).
    if (req.headers['x-s360-csrf'] !== '1' && req.headers['x-client-type'] !== 'native') throw new AppError(403, 'CSRF', 'Missing CSRF header');
    const raw = (req.body as any)?.refreshToken ?? req.cookies[REFRESH_COOKIE];
    const [tenantId, sessionId, secret] = String(raw ?? '').split('.');
    if (!tenantId || !sessionId || !secret || !z.string().uuid().safeParse(tenantId).success || !z.string().uuid().safeParse(sessionId).success) throw unauthorized();
    const outcome = await withTenant({ tenantId }, async (db) => {
      const s = await one<any>(db, `SELECT s.*, u.kind, u.status FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 FOR UPDATE OF s`, [sessionId]);
      if (!s || !safeEqual(s.refresh_hash, sha256(secret))) return { error: unauthorized() };
      if (s.revoked_at) {
        // Reuse of a rotated token ⇒ likely theft: revoke the whole family (committed before we respond).
        await db.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [s.user_id]);
        await audit(db, { ...actor(req), userId: s.user_id }, { action: 'auth.refresh_reuse_detected', entityType: 'user', entityId: s.user_id, source: 'auth' });
        return { error: unauthorized('Session revoked') };
      }
      if (new Date(s.expires_at) < new Date() || s.status !== 'active') return { error: unauthorized('Session expired') };
      await db.query(`UPDATE auth_sessions SET revoked_at = now() WHERE id = $1`, [sessionId]);
      return { ok: await issueSession(db, reply, { id: s.user_id, kind: s.kind }, tenantId, req.ip, req.headers['user-agent'], req.headers['x-client-type'] === 'native') };
    });
    if (outcome.error) throw outcome.error;
    return outcome.ok;
  });

  app.post('/auth/logout', async (req, reply) => {
    await tx(req, async (db, auth) => {
      await db.query(`UPDATE auth_sessions SET revoked_at = now() WHERE id = $1`, [auth.sessionId]);
      await audit(db, actor(req), { action: 'auth.logout', entityType: 'user', entityId: auth.userId, source: 'auth' });
    });
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => tx(req, async (db, auth) => {
    const u = await one<any>(db, `SELECT id, email, full_name, kind, mfa_enabled FROM users WHERE id = $1`, [auth.userId]);
    const t = await one<any>(db, `SELECT id, slug, name FROM tenants WHERE id = $1`, [auth.tenantId]);
    const student = await one<{ id: string }>(db, `SELECT id FROM students WHERE user_id = $1`, [auth.userId]);
    const children = await db.query(`SELECT gl.student_id AS id, s.full_name FROM guardian_links gl JOIN students s ON s.id = gl.student_id WHERE gl.guardian_user_id = $1 AND gl.status = 'active'`, [auth.userId]);
    const roles = await db.query(`SELECT r.key, ra.scope_type, ra.scope_id FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.user_id = $1`, [auth.userId]);
    const perms = [...new Set(auth.principal.grants.flatMap((g) => [...g.permissions]))].sort();
    return { user: u, tenant: t, studentId: student?.id ?? null, children: children.rows, roles: roles.rows, permissions: perms };
  }));

  app.post('/auth/mfa/setup', async (req) => tx(req, async (db, auth) => {
    const u = await one<any>(db, `SELECT email, mfa_enabled FROM users WHERE id = $1`, [auth.userId]);
    if (u.mfa_enabled) throw badRequest('MFA is already enabled');
    const secret = generateTotpSecret();
    await db.query(`UPDATE users SET mfa_secret_enc = $2 WHERE id = $1`, [auth.userId, encrypt(secret)]);
    return { secret, otpauthUrl: otpauthUrl(secret, u.email) };
  }));

  app.post('/auth/mfa/enable', async (req) => tx(req, async (db, auth) => {
    const { code } = parse(z.object({ code: z.string().length(6) }), req.body);
    const u = await one<any>(db, `SELECT mfa_secret_enc FROM users WHERE id = $1`, [auth.userId]);
    if (!u?.mfa_secret_enc || !verifyTotp(decrypt(u.mfa_secret_enc), code)) throw badRequest('Invalid code');
    await db.query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [auth.userId]);
    await audit(db, actor(req), { action: 'auth.mfa_enabled', entityType: 'user', entityId: auth.userId, source: 'auth' });
    return { mfaEnabled: true };
  }));

  app.post('/auth/password', { config: { rateLimit: perMinute(5) } }, async (req) => tx(req, async (db, auth) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body);
    const u = await one<any>(db, `SELECT email, password_hash FROM users WHERE id = $1`, [auth.userId]);
    if (!u.password_hash || !(await verifyPassword(u.password_hash, body.currentPassword))) throw badRequest('Current password is incorrect');
    const errs = passwordPolicyErrors(body.newPassword, u.email);
    if (errs.length) throw badRequest('Password does not meet policy', errs);
    await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [auth.userId, await hashPassword(body.newPassword)]);
    await db.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [auth.userId, auth.sessionId]);
    await audit(db, actor(req), { action: 'auth.password_changed', entityType: 'user', entityId: auth.userId, source: 'auth' });
    return { ok: true };
  }));
}

