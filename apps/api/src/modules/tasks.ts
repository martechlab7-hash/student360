/** Growth Task Engine API. */
import type { FastifyInstance } from 'fastify';
import { can } from '@s360/core';
import { z } from 'zod';
import { orgUnitTarget } from '../auth/principal.js';
import { many, one, type Db } from '../db/pool.js';
import type { AuthContext } from '../auth/principal.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { decodeCursor, page, PageQuery } from '../lib/pagination.js';
import { actor, authorize, authorizeStudent, created, IdParams, parse, requireAnywhere, tx } from '../http/context.js';
import { myStudentId } from '../http/scope.js';
import { redactForStudent } from '../services/taskSchemas.js';
import { createTemplate, publishTemplate, submit, TemplateInput } from '../services/tasks.js';

/** Template-level permission: the caller needs `perm` over every targeted section. */
async function authorizeTargets(db: Db, auth: AuthContext, perm: string, target: { sectionIds?: string[]; studentIds?: string[] }) {
  if (can(auth.principal, perm)) return;
  for (const sid of target.sectionIds ?? []) authorize(auth, perm, await orgUnitTarget(db, auth.tenantId, sid));
  for (const st of target.studentIds ?? []) await authorizeStudent(db, auth, perm, st);
  if (!(target.sectionIds?.length || target.studentIds?.length)) throw forbidden('Only institution-wide staff can create untargeted tasks');
}

export async function taskRoutes(app: FastifyInstance) {
  app.post('/tasks/templates', async (req, reply) => tx(req, async (db, auth) => {
    const body = parse(TemplateInput, req.body);
    await authorizeTargets(db, auth, 'task:create', body.target);
    return created(reply, { id: await createTemplate(db, actor(req), body) });
  }));

  app.get('/tasks/templates', async (req) => tx(req, async (db, auth) => {
    requireAnywhere(auth, 'task:view');
    const q = parse(PageQuery.extend({ status: z.enum(['draft', 'pending_review', 'published', 'archived']).optional() }), req.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (!can(auth.principal, 'task:view')) { params.push(auth.userId); where.push(`t.created_by = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`t.status = $${params.length}`); }
    const cur = decodeCursor(q.cursor);
    if (cur) { params.push(cur[0], cur[1]); where.push(`(t.created_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
    params.push(q.limit + 1);
    const rows = await many(db,
      `SELECT t.id, t.type, t.title, t.mode, t.difficulty_level, t.status, t.source, t.assessment_kind, t.due_at, t.created_at,
              (SELECT count(*)::int FROM task_assignments a WHERE a.template_id = t.id) AS assigned,
              (SELECT count(*)::int FROM task_assignments a WHERE a.template_id = t.id AND a.status IN ('submitted','evaluated')) AS completed
         FROM task_templates t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.created_at DESC, t.id DESC LIMIT $${params.length}`, params);
    return page(rows, q.limit);
  }));

  app.get('/tasks/templates/:id', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const t = await one<any>(db, `SELECT * FROM task_templates WHERE id = $1`, [id]);
    if (!t) throw notFound('Task template');
    await authorizeTargets(db, auth, 'task:view', t.target).catch(() => { if (t.created_by !== auth.userId) throw notFound('Task template'); });
    return t;
  }));

  /** Teacher view of the per-student variants: shows how personalisation preserved difficulty. */
  app.get('/tasks/templates/:id/assignments', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const t = await one<any>(db, `SELECT target, created_by FROM task_templates WHERE id = $1`, [id]);
    if (!t) throw notFound('Task template');
    await authorizeTargets(db, auth, 'task:view', t.target);
    return { items: await many(db,
      `SELECT a.id, a.student_id, s.full_name, a.status, a.path, a.difficulty_level, a.rationale, a.content->>'title' AS title,
              a.content->>'prompt' AS prompt, a.generation, a.due_at,
              (SELECT e.score FROM task_submissions sub JOIN evaluations e ON e.submission_id = sub.id AND e.is_final
                WHERE sub.assignment_id = a.id ORDER BY sub.attempt_no DESC LIMIT 1) AS score
         FROM task_assignments a JOIN students s ON s.id = a.student_id WHERE a.template_id = $1 ORDER BY s.full_name`, [id]) };
  }));

  app.post('/tasks/templates/:id/publish', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const t = await one<any>(db, `SELECT target FROM task_templates WHERE id = $1`, [id]);
    if (!t) throw notFound('Task template');
    await authorizeTargets(db, auth, 'task:publish', t.target);
    return publishTemplate(db, actor(req), id);
  }));

  app.post('/tasks/templates/:id/archive', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const t = await one<any>(db, `SELECT target, status FROM task_templates WHERE id = $1`, [id]);
    if (!t) throw notFound('Task template');
    await authorizeTargets(db, auth, 'task:edit', t.target);
    await db.query(`UPDATE task_templates SET status = 'archived' WHERE id = $1`, [id]);
    await db.query(`UPDATE task_assignments SET status = 'cancelled' WHERE template_id = $1 AND status IN ('pending_generation','assigned','in_progress')`, [id]);
    await audit(db, actor(req), { action: 'task_template.archive', entityType: 'task_template', entityId: id, before: { status: t.status }, after: { status: 'archived' } });
    return { ok: true };
  }));

  // ── Student side ─────────────────────────────────────────────────
  /** Today's Growth: 5–10 small tasks, each with a "why". */
  app.get('/tasks/today', async (req) => tx(req, async (db, auth) => {
    const studentId = await myStudentId(db, auth);
    const rows = await many<any>(db,
      `SELECT a.id, a.status, a.path, a.difficulty_level, a.rationale, a.content, a.due_at, t.type, t.config->>'durationMinutes' AS duration,
              d.name AS dimension, (SELECT e.score FROM task_submissions sub JOIN evaluations e ON e.submission_id = sub.id AND e.is_final
                                     WHERE sub.assignment_id = a.id ORDER BY sub.attempt_no DESC LIMIT 1) AS score
         FROM task_assignments a JOIN task_templates t ON t.id = a.template_id LEFT JOIN growth_dimensions d ON d.id = t.dimension_id
        WHERE a.student_id = $1 AND (a.start_at IS NULL OR a.start_at <= now())
          AND (a.status IN ('assigned','in_progress','submitted') OR (a.status = 'evaluated' AND a.updated_at > date_trunc('day', now())))
        ORDER BY (a.status IN ('assigned','in_progress')) DESC, a.due_at NULLS LAST, a.created_at LIMIT 10`, [studentId]);
    const items = rows.map((r) => ({ ...r, content: redactForStudent(r.type, r.content) }));
    const streak = await one<{ days: number }>(db,
      `WITH d AS (SELECT DISTINCT date_trunc('day', submitted_at)::date AS day FROM task_submissions WHERE student_id = $1),
            g AS (SELECT day, day - (row_number() OVER (ORDER BY day))::int AS grp FROM d)
       SELECT count(*)::int AS days FROM g WHERE grp = (SELECT grp FROM g WHERE day = current_date)`, [studentId]);
    return { items, streakDays: streak?.days ?? 0, completedToday: items.filter((i) => i.status === 'evaluated' || i.status === 'submitted').length };
  }));

  app.get('/tasks/assignments/:id', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const a = await one<any>(db,
      `SELECT a.*, t.type, t.objective, t.rubric, t.config, s.user_id AS student_user_id FROM task_assignments a
         JOIN task_templates t ON t.id = a.template_id JOIN students s ON s.id = a.student_id WHERE a.id = $1`, [id]);
    if (!a) throw notFound('Task');
    const isOwner = a.student_user_id === auth.userId;
    if (!isOwner) await authorizeStudent(db, auth, 'task:view', a.student_id);
    const submissions = await many(db,
      `SELECT sub.id, sub.attempt_no, sub.status, sub.submitted_at, e.score, e.evaluator_type, e.output, e.criteria
         FROM task_submissions sub LEFT JOIN evaluations e ON e.submission_id = sub.id AND e.is_final
        WHERE sub.assignment_id = $1 ORDER BY sub.attempt_no`, [id]);
    return { ...a, student_user_id: undefined, content: isOwner ? redactForStudent(a.type, a.content) : a.content, submissions };
  }));

  app.post('/tasks/assignments/:id/start', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const r = await db.query(`UPDATE task_assignments a SET status = 'in_progress' FROM students s
                               WHERE a.id = $1 AND s.id = a.student_id AND s.user_id = $2 AND a.status = 'assigned' RETURNING a.id`, [id, auth.userId]);
    if (!r.rowCount) throw conflict('Task cannot be started');
    return { ok: true };
  }));

  app.post('/tasks/assignments/:id/submissions', { config: { idempotent: true } }, async (req, reply) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    return created(reply, await submit(db, auth, id, req.body));
  }));
}

