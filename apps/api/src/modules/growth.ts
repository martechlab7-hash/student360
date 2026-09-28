import type { FastifyInstance } from 'fastify';
import { can } from '@s360/core';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { emit } from '../lib/outbox.js';
import { authorizeStudent, IdParams, parse, tx } from '../http/context.js';
import { visibleStudentIds } from '../http/scope.js';
import { growthSummary, measuredImprovement } from '../services/growth.js';
import { nextBestActions } from '../services/recommendations.js';

export async function growthRoutes(app: FastifyInstance) {
  app.get('/students/:id/growth', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const target = await authorizeStudent(db, auth, 'growth:view', id);
    // Sensitive dimensions (e.g. well-being) are visible to staff with an explicit permission only.
    const includeSensitive = auth.kind === 'staff' && can(auth.principal, 'intervention:view', target);
    return growthSummary(db, id, includeSensitive);
  }));

  app.get('/students/:id/next-actions', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    await authorizeStudent(db, auth, 'recommendation:view', id);
    return nextBestActions(db, id);
  }));

  app.get('/students/:id/recommendations', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    await authorizeStudent(db, auth, 'recommendation:view', id);
    return { items: await many(db, `SELECT id, kind, title, body, rationale, source, status, priority, action, created_at FROM recommendations
                                     WHERE student_id = $1 AND status = 'open' ORDER BY priority DESC, created_at DESC LIMIT 20`, [id]) };
  }));

  app.patch('/recommendations/:id', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const { status } = parse(z.object({ status: z.enum(['accepted', 'dismissed', 'done']) }), req.body);
    const r = await one<{ student_id: string }>(db, `SELECT student_id FROM recommendations WHERE id = $1`, [id]);
    if (!r) throw notFound('Recommendation');
    await authorizeStudent(db, auth, 'recommendation:view', r.student_id);
    await db.query(`UPDATE recommendations SET status = $2 WHERE id = $1`, [id, status]);
    return { ok: true };
  }));

  /** Baseline → final measured improvement (the platform's core outcome metric). */
  app.get('/growth/improvement', async (req) => tx(req, async (db, auth) => {
    const ids = await visibleStudentIds(db, auth, 'growth:view');
    if (ids && ids.length === 0) return { items: [] };
    return { items: await measuredImprovement(db, ids),
      note: 'Improvement compares standardized baseline and final assessments. It shows change over the period; it does not by itself prove which activity caused it.' };
  }));

  app.post('/students/:id/growth/recalculate', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    await authorizeStudent(db, auth, 'growth:configure', id);
    await emit(db, 'growth.recalculate', 'student', id, { studentId: id, reason: 'manual' });
    return { queued: true };
  }));
}
