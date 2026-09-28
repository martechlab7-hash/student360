import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { actor, authorizeStudent, IdParams, parse, tx } from '../http/context.js';
import { visibleStudentIds } from '../http/scope.js';
import { pendingReviews, teacherEvaluate } from '../services/evaluation.js';

export async function evaluationRoutes(app: FastifyInstance) {
  app.get('/evaluations/pending', async (req) => tx(req, async (db, auth) => {
    const ids = await visibleStudentIds(db, auth, 'evaluation:evaluate');
    return { items: ids && ids.length === 0 ? [] : await pendingReviews(db, ids) };
  }));

  app.get('/submissions/:id', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const sub = await one<any>(db, `SELECT sub.*, s.user_id FROM task_submissions sub JOIN students s ON s.id = sub.student_id WHERE sub.id = $1`, [id]);
    if (!sub) throw notFound('Submission');
    if (sub.user_id !== auth.userId) await authorizeStudent(db, auth, 'submission:view', sub.student_id);
    // Full audit trail: every evaluation including overridden AI ones, with model + prompt version.
    const evaluations = await many(db,
      `SELECT id, evaluator_type, evaluator_user_id, model, prompt_version, rubric_version, score, criteria, output, status, is_final,
              overrides_id, override_reason, created_at FROM evaluations WHERE submission_id = $1 ORDER BY created_at`, [id]);
    return { ...sub, user_id: undefined, evaluations };
  }));

  app.post('/submissions/:id/evaluate', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const sub = await one<{ student_id: string }>(db, `SELECT student_id FROM task_submissions WHERE id = $1`, [id]);
    if (!sub) throw notFound('Submission');
    await authorizeStudent(db, auth, 'evaluation:evaluate', sub.student_id);
    const body = parse(z.object({ score: z.number().min(0).max(100), feedback: z.string().max(5000).optional(),
      criteria: z.array(z.object({ name: z.string(), score: z.number(), maxScore: z.number() })).optional(), reason: z.string().max(1000).optional() }), req.body);
    return teacherEvaluate(db, auth, actor(req), id, body);
  }));
}
