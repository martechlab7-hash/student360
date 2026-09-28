import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../src/lib/totp.js';
import { api, login, makeTenant, PASSWORD, startApp, stopApp, type Fixture, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let F: Fixture;
beforeAll(async () => { ctx = await startApp(); F = await makeTenant(); });
afterAll(() => stopApp(ctx));

const loginReq = (email: string, password: string, tenant = F.slug) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { tenant, email, password } });

describe('authentication', () => {
  it('logs in and returns /me with permissions', async () => {
    const t = await login(ctx.app, F.slug, `teacher@${F.slug}.edu`);
    const me = await api(ctx.app, t).get('/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().permissions).toContain('task:create');
    expect(me.json().roles[0].scope_type).toBe('section');
  });

  it('uses one generic error for unknown tenant, unknown user and wrong password', async () => {
    const a = await loginReq(`teacher@${F.slug}.edu`, 'wrong-password-1A!');
    const b = await loginReq(`nobody@${F.slug}.edu`, PASSWORD);
    const c = await loginReq(`teacher@${F.slug}.edu`, PASSWORD, 'no-such-tenant');
    for (const r of [a, b, c]) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i++) await loginReq(`s2@${F.slug}.edu`, 'bad-password-XX1!');
    const r = await loginReq(`s2@${F.slug}.edu`, PASSWORD);
    expect(r.statusCode).toBe(423);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-client-type': 'native' },
      payload: { tenant: F.slug, email: `s1@${F.slug}.edu`, password: PASSWORD } });
    const rt1 = first.json().refreshToken;
    const refresh = (rt: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { 'x-client-type': 'native' }, payload: { refreshToken: rt } });
    const second = await refresh(rt1);
    expect(second.statusCode).toBe(200);
    const rt2 = second.json().refreshToken;
    expect(rt2).not.toEqual(rt1);
    // Replaying the old token revokes the whole family.
    expect((await refresh(rt1)).statusCode).toBe(401);
    expect((await refresh(rt2)).statusCode).toBe(401);
    // …and the access token tied to a revoked session stops working.
    expect((await api(ctx.app, second.json().accessToken).get('/auth/me')).statusCode).toBe(401);
  });

  it('refresh from a browser cookie requires the CSRF header', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { s360_rt: 'x.y.z' } });
    expect(r.statusCode).toBe(403);
  });

  it('supports TOTP MFA', async () => {
    const t = await login(ctx.app, F.slug, `admin@${F.slug}.edu`);
    const setup = await api(ctx.app, t).post('/auth/mfa/setup');
    const secret = setup.json().secret;
    expect((await api(ctx.app, t).post('/auth/mfa/enable', { code: '000000' })).statusCode).toBe(400);
    expect((await api(ctx.app, t).post('/auth/mfa/enable', { code: totp(secret) })).statusCode).toBe(200);
    const step1 = await loginReq(`admin@${F.slug}.edu`, PASSWORD);
    expect(step1.json().mfaRequired).toBe(true);
    const step2 = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', payload: { mfaToken: step1.json().mfaToken, code: totp(secret) } });
    expect(step2.statusCode).toBe(200);
    expect(step2.json().accessToken).toBeTruthy();
  });

  it('enforces the password policy', async () => {
    const t = await login(ctx.app, F.slug, `teacher@${F.slug}.edu`);
    const r = await api(ctx.app, t).post('/auth/password', { currentPassword: PASSWORD, newPassword: 'short' });
    expect(r.statusCode).toBe(400);
  });
});
