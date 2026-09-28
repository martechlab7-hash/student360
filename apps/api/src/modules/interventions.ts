import type { FastifyInstance } from 'fastify';
import { canTransitionIntervention, INTERVENTION_STATES } from '@s360/core';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { emit } from '../lib/outbox.js';
import { actor, authorizeStudent, created, IdParams, parse, tx, Uuid } from '../http/context.js';
import { visibleStudentIds } from '../http/scope.js';

export async function interventionRoutes(app: FastifyInstance) {
  app.post('/interventions', async (req, reply) => tx(req, async (db, auth) => {
    const body = parse(z.object({
      studentId: Uuid, kind: z.enum(['remedial_plan', 'mentoring', 'additional_practice', 'communication_mission', 'technical_mission', 'parent_communication', 'counselling_referral']),
      title: z.string().min(3).max(200), goal: z.string().min(3).max(2000), skillId: Uuid.optional(), assigneeId: Uuid.optional(), dueAt: z.coerce.date().optional(),
    }), req.body);
    await authorizeStudent(db, auth, 'intervention:create', body.studentId);
    if (body.kind === 'parent_communication') {
      const policy = await one<any>(db, `SELECT privacy FROM tenant_policies`);
      if (policy?.privacy?.allowParentCommunication === false) throw conflict('Institution policy does not permit parent communication interventions');
    }
    // Capture the baseline so the outcome can be measured later.
    const baseline = body.skillId
      ? await one(db, `SELECT proficiency AS score, now() AS at FROM student_skills WHERE student_id = $1 AND skill_id = $2`, [body.studentId, body.skillId])
      : await one(db, `SELECT overall AS score, snapshot_date AS at FROM growth_snapshots WHERE student_id = $1 ORDER BY snapshot_date DESC LIMIT 1`, [body.studentId]);
    const i = await one<{ id: string }>(db,
      `INSERT INTO interventions (student_id, kind, title, goal, skill_id, owner_id, assignee_id, baseline, due_at, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [body.studentId, body.kind, body.title, body.goal, body.skillId ?? null, auth.userId, body.assigneeId ?? null, baseline && JSON.stringify(baseline),
        body.dueAt ?? null, body.assigneeId ? 'assigned' : 'created']);
    await db.query(`INSERT INTO intervention_events (intervention_id, to_state, actor_id) VALUES ($1,$2,$3)`, [i!.id, body.assigneeId ? 'assigned' : 'created', auth.userId]);
    await audit(db, actor(req), { action: 'intervention.create', entityType: 'intervention', entityId: i!.id, after: body });
    await emit(db, 'intervention.changed', 'intervention', i!.id, { studentId: body.studentId, state: 'created', ownerId: auth.userId, assigneeId: body.assigneeId });
    return created(reply, { id: i!.id });
  }));

  app.get('/interventions', async (req) => tx(req, async (db, auth) => {
    const ids = await visibleStudentIds(db, auth, 'intervention:view');
    if (ids && ids.length === 0) return { items: [] };
    return { items: await many(db,
      `SELECT i.*, s.full_name FROM interventions i JOIN students s ON s.id = i.student_id
        WHERE ($1::uuid[] IS NULL OR i.student_id = ANY($1)) ORDER BY i.updated_at DESC LIMIT 200`, [ids]) };
  }));

  app.post('/interventions/:id/transition', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ to: z.enum(INTERVENTION_STATES), note: z.string().max(2000).optional(), assigneeId: Uuid.optional() }), req.body);
    const i = await one<any>(db, `SELECT * FROM interventions WHERE id = $1 FOR UPDATE`, [id]);
    if (!i) throw notFound('Intervention');
    await authorizeStudent(db, auth, 'intervention:edit', i.student_id);
    if (!canTransitionIntervention(i.state, body.to)) throw badRequest(`Cannot move from ${i.state} to ${body.to}`);
    let outcome = i.outcome;
    if (body.to === 'evaluated') {
      // Measured outcome: compare against the baseline captured at creation.
      const now = i.skill_id
        ? await one<any>(db, `SELECT proficiency AS score FROM student_skills WHERE student_id = $1 AND skill_id = $2`, [i.student_id, i.skill_id])
        : await one<any>(db, `SELECT overall AS score FROM growth_snapshots WHERE student_id = $1 ORDER BY snapshot_date DESC LIMIT 1`, [i.student_id]);
      const b = i.baseline?.score;
      outcome = { score: now?.score ?? null, at: new Date().toISOString(), improvement: b != null && now?.score != null ? Math.round((now.score - b) * 10) / 10 : null, note: body.note };
    }
    await db.query(`UPDATE interventions SET state = $2, outcome = $3, assignee_id = COALESCE($4, assignee_id) WHERE id = $1`,
      [id, body.to, outcome && JSON.stringify(outcome), body.assigneeId ?? null]);
    await db.query(`INSERT INTO intervention_events (intervention_id, from_state, to_state, actor_id, note) VALUES ($1,$2,$3,$4,$5)`, [id, i.state, body.to, auth.userId, body.note ?? null]);
    await audit(db, actor(req), { action: 'intervention.transition', entityType: 'intervention', entityId: id, before: { state: i.state }, after: { state: body.to, outcome } });
    await emit(db, 'intervention.changed', 'intervention', id, { studentId: i.student_id, state: body.to, ownerId: i.owner_id, assigneeId: body.assigneeId ?? i.assignee_id });
    return { ok: true, outcome };
  }));
}
