/** AI evaluation safety: rubric consistency, server-side scoring, human review routing. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerProvider } from '../src/ai/gateway.js';
import { MockProvider } from '../src/ai/providers/mock.js';
import type { AIProvider, AIRequest } from '../src/ai/types.js';
import { withTenant } from '../src/db/pool.js';
import { api, drain, login, makeTenant, startApp, stopApp, type Fixture, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let F: Fixture;
beforeAll(async () => { ctx = await startApp(); F = await makeTenant(); });
afterAll(() => stopApp(ctx));

/** Scripted provider: returns whatever evaluation the test sets. */
let scripted: Record<string, unknown> | null = null;
const scriptedProvider: AIProvider = {
  name: 'scripted',
  async generate<T>(req: AIRequest<T>) {
    if (req.promptKey !== 'evaluation.rubric' || !scripted) return new MockProvider().generate(req);
    return { output: req.schema.parse(scripted), model: 'scripted-1', inputTokens: 10, outputTokens: 10 };
  },
};

async function submitReflection(studentIdx: number, title: string, text: string) {
  const t = api(ctx.app, await login(ctx.app, F.slug, `teacher@${F.slug}.edu`));
  const id = (await t.post('/tasks/templates', { type: 'reflection', title, objective: 'Reflect', difficultyLevel: 'basic', mode: 'STANDARDIZED',
    rubric: [{ name: 'Depth', description: 'd', maxPoints: 60 }, { name: 'Clarity', description: 'c', maxPoints: 40 }],
    target: { studentIds: [F.students[studentIdx]!.id] } })).json().id;
  await t.post(`/tasks/templates/${id}/publish`);
  await drain(ctx.bus);
  const s = api(ctx.app, await login(ctx.app, F.slug, `s${studentIdx}@${F.slug}.edu`));
  const task = (await s.get('/tasks/today')).json().items.find((i: any) => i.content.title === title);
  const sub = (await s.post(`/tasks/assignments/${task.id}/submissions`, { text })).json().submissionId;
  await drain(ctx.bus);
  return (await t.get(`/submissions/${sub}`)).json();
}

describe('AI evaluation', () => {
  it('golden consistency: identical input yields identical rubric scores', async () => {
    const text = 'Firstly I practised daily. Secondly I asked for feedback because it helps. In conclusion, consistency matters most for growth over a semester of study.';
    const a = await submitReflection(0, 'Golden A', text);
    const b = await submitReflection(1, 'Golden B', text);
    expect(a.evaluations[0].score).toBe(b.evaluations[0].score);
    expect(a.evaluations[0].criteria).toEqual(b.evaluations[0].criteria);
  });

  it('never trusts model arithmetic: criterion scores are clamped to rubric maxima', async () => {
    registerProvider(scriptedProvider);
    await withTenant({ tenantId: F.tenantId }, (db) => db.query(`INSERT INTO ai_model_configs (feature, provider, model) VALUES ('evaluation','scripted','scripted-1')
      ON CONFLICT (tenant_id, feature) DO UPDATE SET provider = 'scripted'`));
    scripted = { criteria: [{ name: 'Depth', score: 500, maxScore: 1000, evidence: 'x', feedback: 'y' }, { name: 'Clarity', score: -20, maxScore: 40, evidence: 'x', feedback: 'y' }],
      overallFeedback: 'ok', strengths: [], improvements: [], conceptsMissed: [], confidence: 0.9, flagForHumanReview: false };
    const r = await submitReflection(2, 'Clamp', 'Some reflection text that is long enough.');
    const e = r.evaluations[0];
    expect(e.criteria.find((c: any) => c.name === 'Depth')).toMatchObject({ score: 60, maxScore: 60 });
    expect(e.criteria.find((c: any) => c.name === 'Clarity').score).toBe(0);
    expect(e.score).toBe(60);
    expect(e.model).toBe('scripted-1');
  });

  it('low model confidence routes the evaluation to a teacher', async () => {
    scripted = { criteria: [{ name: 'Depth', score: 30, maxScore: 60, evidence: 'x', feedback: 'y' }, { name: 'Clarity', score: 20, maxScore: 40, evidence: 'x', feedback: 'y' }],
      overallFeedback: 'unsure', strengths: [], improvements: [], conceptsMissed: [], confidence: 0.3, flagForHumanReview: false };
    const r = await submitReflection(0, 'Low confidence', 'Ambiguous answer.');
    expect(r.status).toBe('needs_review');
    expect(r.evaluations[0]).toMatchObject({ status: 'needs_review', is_final: false });
    scripted = null;
  });
});
