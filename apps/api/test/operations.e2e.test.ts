import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueAttendanceToken } from '@s360/core';
import { one, withTenant } from '../src/db/pool.js';
import { registerProvider } from '../src/ai/gateway.js';
import { AIRetryableError, type AIProvider } from '../src/ai/types.js';
import { decrypt } from '../src/lib/crypto.js';
import { api, drain, login, makeTenant, startApp, stopApp, type Fixture, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let F: Fixture;
let admin: ReturnType<typeof api>;
beforeAll(async () => {
  ctx = await startApp();
  F = await makeTenant();
  admin = api(ctx.app, await login(ctx.app, F.slug, `admin@${F.slug}.edu`));
});
afterAll(() => stopApp(ctx));

describe('event attendance with dynamic QR', () => {
  let eventId: string;
  let sessionId: string;
  const token = async () => (await admin.get(`/events/sessions/${sessionId}/token`)).json().token as string;

  it('organiser creates a published event with a live session', async () => {
    eventId = (await admin.post('/events', { name: 'Hackathon', organizer: 'Tech Club', category: 'technical', dimensionKey: 'technical' })).json().id;
    const now = Date.now();
    sessionId = (await admin.post(`/events/${eventId}/sessions`, { startsAt: new Date(now - 60_000), endsAt: new Date(now + 3_600_000) })).json().id;
    expect((await admin.post(`/events/${eventId}/publish`)).statusCode).toBe(200);
  });

  it('registered student checks in with the current token → verified evidence', async () => {
    const s0 = api(ctx.app, await login(ctx.app, F.slug, `s0@${F.slug}.edu`));
    expect((await s0.post(`/events/${eventId}/register`)).statusCode).toBe(201);
    const r = await s0.post('/attendance/check-in', { sessionId, token: await token(), deviceId: 'device-A' });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe('accepted');
    const ev = (await s0.get(`/students/${F.students[0]!.id}/evidence`)).json().items.find((e: any) => e.activity_type === 'event_participation');
    expect(ev.verification_level).toBe('VERIFIED');
    // Duplicate check-in is rejected.
    expect((await s0.post('/attendance/check-in', { sessionId, token: await token(), deviceId: 'device-A' })).statusCode).toBe(409);
  });

  it('rejects forged and expired tokens', async () => {
    const s1 = api(ctx.app, await login(ctx.app, F.slug, `s1@${F.slug}.edu`));
    expect((await s1.post('/attendance/check-in', { sessionId, token: '123.forgedsignature000000' })).json().error.code).toBe('INVALID_ATTENDANCE_TOKEN');
    const secret = await withTenant({ tenantId: F.tenantId }, async (db) =>
      decrypt((await one<{ attendance_secret: string }>(db, `SELECT attendance_secret FROM event_sessions WHERE id = $1`, [sessionId]))!.attendance_secret));
    const old = issueAttendanceToken(secret, sessionId, Date.now() - 5 * 60_000).token;
    const r = await s1.post('/attendance/check-in', { sessionId, token: old });
    expect(r.json().error.message).toMatch(/expired/);
  });

  it('flags (does not reject) an unregistered check-in from a device already used by another student', async () => {
    const s1 = api(ctx.app, await login(ctx.app, F.slug, `s1@${F.slug}.edu`));
    const r = await s1.post('/attendance/check-in', { sessionId, token: await token(), deviceId: 'device-A' });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe('flagged');
    const flagged = (await admin.get('/attendance/flagged')).json().items;
    const f = flagged.find((x: any) => x.student_id === F.students[1]!.id);
    expect(f.flags).toEqual(expect.arrayContaining(['SHARED_DEVICE', 'NOT_REGISTERED']));
    const ev = (await s1.get(`/students/${F.students[1]!.id}/evidence`)).json().items.find((e: any) => e.activity_type === 'event_participation');
    expect(ev.verification_level).toBe('PARTIALLY_VERIFIED');

    // Organiser reviews and accepts → evidence becomes verified, with history.
    expect((await admin.post(`/attendance/${f.id}/review`, { decision: 'accepted', note: 'Shared phone; confirmed in person' })).statusCode).toBe(200);
    const ev2 = (await s1.get(`/students/${F.students[1]!.id}/evidence`)).json().items.find((e: any) => e.activity_type === 'event_participation');
    expect(ev2.verification_level).toBe('VERIFIED');
    expect(ev2.history).toHaveLength(1);
    await drain(ctx.bus);
  });

  it('only staff can obtain attendance tokens', async () => {
    const s0 = api(ctx.app, await login(ctx.app, F.slug, `s0@${F.slug}.edu`));
    expect((await s0.get(`/events/sessions/${sessionId}/token`)).statusCode).toBeGreaterThanOrEqual(403);
  });
});

describe('self-reported evidence', () => {
  it('starts SELF_REPORTED and can be verified only by staff', async () => {
    const s0 = api(ctx.app, await login(ctx.app, F.slug, `s0@${F.slug}.edu`));
    const r = await s0.post('/evidence', { title: 'AWS Cloud Practitioner', activityType: 'certification', dimensionKey: 'technical', externalUrl: 'https://example.com/cert' });
    expect(r.json().verificationLevel).toBe('SELF_REPORTED');
    expect((await s0.post(`/evidence/${r.json().id}/verify`, { level: 'VERIFIED' })).statusCode).toBe(404);
    const t = api(ctx.app, await login(ctx.app, F.slug, `teacher@${F.slug}.edu`));
    const queue = (await t.get('/evidence/review')).json().items;
    expect(queue.some((e: any) => e.id === r.json().id)).toBe(true);
    expect((await t.post(`/evidence/${r.json().id}/verify`, { level: 'VERIFIED', note: 'Checked credential ID' })).statusCode).toBe(200);
  });
});

describe('integration hub', () => {
  const payload = () => ({ system: 'erp', records: [
    { externalId: 'E-1', fullName: 'Imported One', sectionCode: 'A-section', rollNo: 'IMP1' },
    { externalId: 'E-2', fullName: 'Imported Two', sectionCode: 'A-section' },
    { externalId: 'E-3', fullName: 'Bad Section', sectionCode: 'nope' },
  ] });

  it('imports students idempotently: retries and re-syncs never duplicate', async () => {
    const r1 = await admin.post('/integrations/students/import', payload());
    expect(r1.statusCode).toBe(202);
    await drain(ctx.bus);
    const r2 = await admin.post('/integrations/students/import', payload());
    expect(r2.json().duplicate).toBe(true); // same payload → same sync job
    const jobs = (await admin.get('/integrations/sync-jobs')).json().items;
    expect(jobs[0]).toMatchObject({ status: 'partial' });
    expect(jobs[0].stats).toMatchObject({ created: 2, failed: 1 });

    // A changed re-sync updates in place.
    const changed = payload(); changed.records[0]!.fullName = 'Imported One Renamed';
    await admin.post('/integrations/students/import', changed, { 'idempotency-key': 'sync-2' });
    await drain(ctx.bus);
    const list = (await admin.get('/students?search=Imported')).json().items;
    expect(list).toHaveLength(2);
    expect(list.map((s: any) => s.full_name)).toContain('Imported One Renamed');
  });
});

describe('interventions measure outcomes', () => {
  it('captures a baseline and computes improvement on evaluation', async () => {
    const t = api(ctx.app, await login(ctx.app, F.slug, `teacher@${F.slug}.edu`));
    const sid = F.students[0]!.id;
    await withTenant({ tenantId: F.tenantId }, (db) => db.query(
      `INSERT INTO student_skills (student_id, skill_id, proficiency, confidence) VALUES ($1,$2,40,0.5)
       ON CONFLICT (student_id, skill_id) DO UPDATE SET proficiency = 40`, [sid, F.skills.aptitude]));
    const i = (await t.post('/interventions', { studentId: sid, kind: 'additional_practice', title: 'Aptitude practice', goal: 'Reach 60', skillId: F.skills.aptitude })).json().id;
    expect((await t.post(`/interventions/${i}/transition`, { to: 'completed' })).statusCode).toBe(400); // must follow the state machine
    for (const to of ['assigned', 'accepted', 'in_progress', 'completed']) expect((await t.post(`/interventions/${i}/transition`, { to })).statusCode).toBe(200);
    await withTenant({ tenantId: F.tenantId }, (db) => db.query(`UPDATE student_skills SET proficiency = 58 WHERE student_id = $1 AND skill_id = $2`, [sid, F.skills.aptitude]));
    const r = await t.post(`/interventions/${i}/transition`, { to: 'evaluated', note: 'Consistent practice' });
    expect(r.json().outcome.improvement).toBe(18);
    // Not visible to the student's parent.
    const p = api(ctx.app, await login(ctx.app, F.slug, `parent@${F.slug}.edu`));
    expect((await p.get('/interventions')).json().items).toEqual([]);
  });
});

describe('AI governance', () => {
  it('logs every AI call with prompt version, tokens and model', async () => {
    const s0 = api(ctx.app, await login(ctx.app, F.slug, `s0@${F.slug}.edu`));
    const r = await s0.post('/ai/mentor', { message: 'What should I do today?' });
    expect(r.statusCode).toBe(200);
    expect(r.json().actions.length).toBeGreaterThan(0);
    for (const a of r.json().actions) expect(a.reason).toBeTruthy();
    const usage = (await admin.get('/ai/usage')).json().byFeature;
    expect(usage.find((u: any) => u.feature === 'mentor').calls).toBeGreaterThan(0);
  });

  it('respects the institution AI switch and consent policy', async () => {
    expect((await admin.put('/config/ai', { policy: { enabled: true, requireConsent: true } })).statusCode).toBe(200);
    const s0 = api(ctx.app, await login(ctx.app, F.slug, `s0@${F.slug}.edu`));
    expect((await s0.post('/ai/mentor', { message: 'hi' })).json().error.code).toBe('CONSENT_REQUIRED');
    await s0.post('/privacy/consents', { purpose: 'ai_processing', granted: true, policyVersion: '2026-01' });
    expect((await s0.post('/ai/mentor', { message: 'hi' })).statusCode).toBe(200);
    await admin.put('/config/ai', { policy: { enabled: false, requireConsent: true } });
    expect((await s0.post('/ai/mentor', { message: 'hi' })).json().error.code).toBe('AI_DISABLED');
    await admin.put('/config/ai', { policy: { enabled: true, requireConsent: false } });
  });

  it('when AI evaluation fails, work is routed to a teacher instead of being lost', async () => {
    const failing: AIProvider = { name: 'flaky', async generate() { throw new AIRetryableError('upstream 529'); } };
    registerProvider(failing);
    await admin.put('/config/ai', { models: [{ feature: 'evaluation', provider: 'mock', model: 'x', enabled: true }] });
    await withTenant({ tenantId: F.tenantId }, (db) => db.query(`UPDATE ai_model_configs SET provider = 'flaky' WHERE feature = 'evaluation'`));
    const t = api(ctx.app, await login(ctx.app, F.slug, `teacher@${F.slug}.edu`));
    const tpl = (await t.post('/tasks/templates', { type: 'reflection', title: 'Weekly reflection', objective: 'Reflect on the week', difficultyLevel: 'basic',
      mode: 'STANDARDIZED', target: { studentIds: [F.students[1]!.id] } })).json().id;
    await t.post(`/tasks/templates/${tpl}/publish`);
    await drain(ctx.bus);
    const s1 = api(ctx.app, await login(ctx.app, F.slug, `s1@${F.slug}.edu`));
    const task = (await s1.get('/tasks/today')).json().items.find((i: any) => i.type === 'reflection');
    await s1.post(`/tasks/assignments/${task.id}/submissions`, { text: 'This week I practised aptitude daily.' });
    await drain(ctx.bus);
    const pending = (await t.get('/evaluations/pending')).json().items;
    expect(pending.some((p: any) => p.title === 'Weekly reflection')).toBe(true);
    const fails = await withTenant({ tenantId: F.tenantId }, (db) => db.query(`SELECT status, retries FROM ai_interactions WHERE provider = 'flaky'`));
    expect(fails.rows[0]).toMatchObject({ status: 'failed', retries: 2 });
  });
});
