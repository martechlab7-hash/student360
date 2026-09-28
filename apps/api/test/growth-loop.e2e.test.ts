/**
 * E2E: Teacher objective → AI-personalised tasks → student submission → evaluation → evidence →
 * skill update → growth score → teacher override → baseline/final measured improvement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { api, drain, login, makeTenant, startApp, stopApp, type Fixture, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let F: Fixture;
let teacher: ReturnType<typeof api>;
let s0: ReturnType<typeof api>;
let s1: ReturnType<typeof api>;

beforeAll(async () => {
  ctx = await startApp();
  F = await makeTenant();
  teacher = api(ctx.app, await login(ctx.app, F.slug, `teacher@${F.slug}.edu`));
  s0 = api(ctx.app, await login(ctx.app, F.slug, `s0@${F.slug}.edu`));
  s1 = api(ctx.app, await login(ctx.app, F.slug, `s1@${F.slug}.edu`));
});
afterAll(() => stopApp(ctx));

describe('EQUIVALENT mode: same objective, different task per student', () => {
  let templateId: string;

  it('teacher cannot target a section they do not teach', async () => {
    const r = await teacher.post('/tasks/templates', {
      type: 'audio', title: 'x', objective: 'y', skillIds: [F.skills.speaking], difficultyLevel: 'intermediate', target: { sectionIds: [F.org.secB] },
    });
    expect(r.statusCode).toBe(403);
  });

  it('teacher creates and publishes an intermediate speaking activity', async () => {
    const r = await teacher.post('/tasks/templates', {
      type: 'audio', title: 'Intermediate English Speaking', objective: 'Take a position on a debatable topic with two reasons and a conclusion.',
      skillIds: [F.skills.speaking], difficultyLevel: 'intermediate', mode: 'EQUIVALENT', target: { sectionIds: [F.org.secA] },
      config: { attempts: 2 },
    });
    expect(r.statusCode).toBe(201);
    templateId = r.json().id;
    expect((await teacher.post(`/tasks/templates/${templateId}/publish`)).statusCode).toBe(200);
    await drain(ctx.bus);
  });

  it('each student in the section received a personalised, difficulty-validated variant with a rationale', async () => {
    const r = await teacher.get(`/tasks/templates/${templateId}/assignments`);
    const items = r.json().items;
    expect(items).toHaveLength(3); // section A only
    const prompts = new Set(items.map((i: any) => i.prompt));
    expect(prompts.size).toBe(3);
    for (const i of items) {
      expect(i.generation.personalized).toBe(true);
      expect(i.generation.lastCheck.ok).toBe(true);
      expect(i.difficulty_level).toBe('intermediate');
      expect(i.rationale).toMatch(/comparable difficulty/);
    }
  });

  it('publishing again is idempotent (no duplicate assignments)', async () => {
    expect((await teacher.post(`/tasks/templates/${templateId}/publish`)).json().alreadyPublished).toBe(true);
    await drain(ctx.bus);
    expect((await teacher.get(`/tasks/templates/${templateId}/assignments`)).json().items).toHaveLength(3);
  });

  it("student sees today's task with a 'why'", async () => {
    const r = await s0.get('/tasks/today');
    expect(r.statusCode).toBe(200);
    const t = r.json().items.find((i: any) => i.type === 'audio');
    expect(t.rationale).toBeTruthy();
    expect(t.content.prompt).toMatch(/Speak for 2 minutes/);
  });

  it('submission → AI evaluation → partially-verified evidence → skill → growth score', async () => {
    const task = (await s0.get('/tasks/today')).json().items.find((i: any) => i.type === 'audio');
    const key = randomUUID();
    const body = { transcript: 'Firstly, I believe part-time work helps students because it builds responsibility. Secondly, it teaches time management and gives real experience of teamwork with colleagues. However, it must not harm studies. In conclusion, part-time work is valuable when limited to a few hours a week and when students plan their time well and keep learning.' };
    const r1 = await s0.post(`/tasks/assignments/${task.id}/submissions`, body, { 'idempotency-key': key });
    expect(r1.statusCode).toBe(201);
    // Network retry with the same key replays the response instead of creating a second attempt.
    const r2 = await s0.post(`/tasks/assignments/${task.id}/submissions`, body, { 'idempotency-key': key });
    expect(r2.statusCode).toBe(201);
    expect(r2.headers['idempotent-replay']).toBe('true');
    expect(r2.json().submissionId).toBe(r1.json().submissionId);
    await drain(ctx.bus);

    const sub = await s0.get(`/submissions/${r1.json().submissionId}`);
    const ev = sub.json().evaluations[0];
    expect(ev.evaluator_type).toBe('ai');
    expect(ev.prompt_version).toBe('evaluation.rubric@1.0.0');
    expect(ev.is_final).toBe(true);
    // Pronunciation can't be judged from a transcript — the rubric still lists it.
    expect(ev.criteria.map((c: any) => c.name)).toContain('Pronunciation');

    const evidence = await s0.get(`/students/${F.students[0]!.id}/evidence`);
    const item = evidence.json().items.find((e: any) => e.activity_type === 'audio');
    expect(item.verification_level).toBe('PARTIALLY_VERIFIED'); // AI-only scoring is not fully verified

    const growth = await s0.get(`/students/${F.students[0]!.id}/growth`);
    expect(growth.json().current.overall).toBeGreaterThan(0);
    expect(growth.json().current.evidenceConfidence).toBeGreaterThan(0);
    expect(growth.json().skills.find((s: any) => s.id === F.skills.speaking).evidence_count).toBe(1);
  });

  it('teacher override replaces the score, is audited, and keeps the AI evaluation', async () => {
    const task = (await s0.get('/tasks/today')).json().items.find((i: any) => i.type === 'audio');
    const detail = await teacher.get(`/tasks/assignments/${task.id}`);
    const submissionId = detail.json().submissions[0].id;
    const before = (await s0.get(`/students/${F.students[0]!.id}/growth`)).json().skills[0].proficiency;

    expect((await teacher.post(`/submissions/${submissionId}/evaluate`, { score: 95 })).statusCode).toBe(400); // reason required
    const r = await teacher.post(`/submissions/${submissionId}/evaluate`, { score: 95, reason: 'Excellent delivery observed in class' });
    expect(r.statusCode).toBe(200);
    await drain(ctx.bus);

    const sub = (await teacher.get(`/submissions/${submissionId}`)).json();
    expect(sub.evaluations).toHaveLength(2);
    const final = sub.evaluations.find((e: any) => e.is_final);
    expect(final.evaluator_type).toBe('teacher');
    expect(final.overrides_id).toBe(sub.evaluations.find((e: any) => e.evaluator_type === 'ai').id);

    const after = (await s0.get(`/students/${F.students[0]!.id}/growth`)).json().skills[0].proficiency;
    expect(after).toBeGreaterThan(before);
    const evidence = (await s0.get(`/students/${F.students[0]!.id}/evidence`)).json().items.find((e: any) => e.activity_type === 'audio');
    expect(evidence.verification_level).toBe('VERIFIED'); // teacher-confirmed

    const admin = api(ctx.app, await login(ctx.app, F.slug, `admin@${F.slug}.edu`));
    const audit = (await admin.get(`/audit?action=evaluation.override`)).json().items;
    expect(audit[0].after.score).toBe(95);
    expect(audit[0].before.evaluator).toBe('ai');
  });

  it('students cannot submit to someone else\'s assignment', async () => {
    const task = (await s0.get('/tasks/today')).json().items.find((i: any) => i.type === 'audio');
    const r = await s1.post(`/tasks/assignments/${task.id}/submissions`, { transcript: 'hello' });
    expect(r.statusCode).toBe(404);
  });
});

describe('STANDARDIZED MCQ: auto-graded, answer key never exposed, scores never trusted from client', () => {
  let templateId: string;
  it('creates, publishes and assigns identical content', async () => {
    const r = await teacher.post('/tasks/templates', {
      type: 'mcq', title: 'Percentages', objective: 'Percentage change', skillIds: [F.skills.aptitude], difficultyLevel: 'basic', mode: 'STANDARDIZED',
      content: { question: '400 → 500 is what % increase?', options: ['20%', '25%', '80%'], answerIndex: 1 }, target: { sectionIds: [F.org.secA] },
    });
    templateId = r.json().id;
    await teacher.post(`/tasks/templates/${templateId}/publish`);
    await drain(ctx.bus);
    const items = (await teacher.get(`/tasks/templates/${templateId}/assignments`)).json().items;
    expect(new Set(items.map((i: any) => i.prompt)).size).toBe(1);
    expect(items.every((i: any) => i.generation.personalized === false)).toBe(true);
  });

  it('student view has no answerIndex; client-sent score is ignored', async () => {
    const task = (await s1.get('/tasks/today')).json().items.find((i: any) => i.type === 'mcq');
    expect(task.content.answerIndex).toBeUndefined();
    expect(task.content.options).toHaveLength(3);
    const bad = await s1.post(`/tasks/assignments/${task.id}/submissions`, { answerIndex: 0, score: 100 });
    expect(bad.statusCode).toBe(201);
    await drain(ctx.bus);
    const detail = (await s1.get(`/tasks/assignments/${task.id}`)).json();
    expect(detail.submissions[0].score).toBe(0);
    expect(detail.submissions[0].evaluator_type).toBe('auto');
    expect(detail.content.answerIndex).toBeUndefined();
  });

  it('enforces attempt limits', async () => {
    const task = (await s1.get('/tasks/today')).json().items.find((i: any) => i.type === 'mcq');
    expect((await s1.post(`/tasks/assignments/${task.id}/submissions`, { answerIndex: 1 })).statusCode).toBe(409);
  });
});

describe('baseline → final: measured improvement', () => {
  it('reports improvement from standardized assessments only', async () => {
    const mk = async (kind: 'baseline' | 'final') => {
      const r = await teacher.post('/tasks/templates', {
        type: 'mcq', title: `Aptitude ${kind}`, objective: 'Aptitude check', skillIds: [F.skills.aptitude], difficultyLevel: 'intermediate',
        mode: 'STANDARDIZED', assessmentKind: kind, content: { question: 'Q', options: ['a', 'b'], answerIndex: 1 }, target: { studentIds: [F.students[2]!.id] },
      });
      expect(r.statusCode).toBe(201);
      await teacher.post(`/tasks/templates/${r.json().id}/publish`);
      await drain(ctx.bus);
      return r.json().id;
    };
    // Non-standardized baselines are rejected outright.
    const bad = await teacher.post('/tasks/templates', { type: 'text_response', title: 'x', objective: 'y', difficultyLevel: 'basic', mode: 'EQUIVALENT',
      assessmentKind: 'baseline', target: { sectionIds: [F.org.secA] } });
    expect(bad.statusCode).toBe(400);

    const s2 = api(ctx.app, await login(ctx.app, F.slug, `s2@${F.slug}.edu`));
    await mk('baseline');
    let t = (await s2.get('/tasks/today')).json().items.find((i: any) => i.content.title === 'Aptitude baseline');
    await s2.post(`/tasks/assignments/${t.id}/submissions`, { answerIndex: 0 });
    await drain(ctx.bus);
    await mk('final');
    t = (await s2.get('/tasks/today')).json().items.find((i: any) => i.content.title === 'Aptitude final');
    await s2.post(`/tasks/assignments/${t.id}/submissions`, { answerIndex: 1 });
    await drain(ctx.bus);

    const rep = (await teacher.get('/growth/improvement')).json();
    const apt = rep.items.find((i: any) => i.skill === 'Aptitude');
    expect(apt).toMatchObject({ students: 1, avg_baseline: 0, avg_final: 100, avg_improvement: 100, improved: 1 });
    expect(rep.note).toMatch(/does not by itself prove/);
  });
});

describe('dashboards', () => {
  it('teacher dashboard lists pending work and neutral insights for their scope only', async () => {
    const r = await teacher.get('/dashboard/teacher');
    expect(r.statusCode).toBe(200);
    const names = r.json().classes.map((c: any) => c.name);
    expect(names).toEqual(['A']);
    for (const i of r.json().insights) expect(i.message).not.toMatch(/lazy|weak|problematic/i);
  });

  it('student dashboard has growth + next actions with reasons', async () => {
    const r = await s0.get('/dashboard/student');
    expect(r.statusCode).toBe(200);
    expect(r.json().growth.current).toBeTruthy();
    for (const a of r.json().nextActions) expect(a.why).toBeTruthy();
  });

  it('parent summary excludes sensitive and staff-only data', async () => {
    const p = api(ctx.app, await login(ctx.app, F.slug, `parent@${F.slug}.edu`));
    const r = (await p.get(`/parent/children/${F.students[0]!.id}/summary`)).json();
    expect(r.growth.score).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toMatch(/intervention|wellbeing|Well-being|ai_output/i);
  });
});
