/** Student 360 profile — the central object the Growth Engine operates on. */
import type { FastifyInstance } from 'fastify';
import { can } from '@s360/core';
import { z } from 'zod';
import { orgUnitTarget, studentScopeFilter } from '../auth/principal.js';
import { many, one } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { emit } from '../lib/outbox.js';
import { decodeCursor, page, PageQuery } from '../lib/pagination.js';
import { actor, authorize, authorizeStudent, created, IdParams, parse, tx, Uuid } from '../http/context.js';
import { myStudentId } from '../http/scope.js';
import { createStudent, linkGuardian } from '../services/people.js';

export async function studentRoutes(app: FastifyInstance) {
  app.get('/students', async (req) => tx(req, async (db, auth) => {
    const q = parse(PageQuery.extend({ sectionId: Uuid.optional(), search: z.string().max(100).optional() }), req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const scope = can(auth.principal, 'student:view') ? null : studentScopeFilter(auth.principal, 'student:view', 1);
    if (scope) { where.push(scope.sql); params.push(...scope.params); }
    if (q.sectionId) { params.push(q.sectionId); where.push(`sec.path @> ARRAY[$${params.length}]::uuid[]`); }
    if (q.search) { params.push(`%${q.search}%`); where.push(`(s.full_name ILIKE $${params.length} OR s.roll_no ILIKE $${params.length})`); }
    const cur = decodeCursor(q.cursor);
    if (cur) { params.push(cur[0], cur[1]); where.push(`(s.created_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
    params.push(q.limit + 1);
    const rows = await many(db,
      `SELECT s.id, s.full_name, s.roll_no, s.status, s.section_id, sec.name AS section, s.created_at,
              g.overall AS growth_score, g.evidence_confidence
         FROM students s JOIN org_units sec ON sec.id = s.section_id
         LEFT JOIN LATERAL (SELECT overall, evidence_confidence FROM growth_snapshots gs WHERE gs.student_id = s.id ORDER BY snapshot_date DESC LIMIT 1) g ON true
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.created_at DESC, s.id DESC LIMIT $${params.length}`, params);
    return page(rows, q.limit);
  }));

  app.post('/students', async (req, reply) => tx(req, async (db, auth) => {
    const body = parse(z.object({
      fullName: z.string().min(1).max(200), email: z.string().email().optional(), sectionId: Uuid, rollNo: z.string().max(50).optional(),
      enrollmentYear: z.number().int().min(1990).max(2100).optional(), interests: z.array(z.string().max(60)).max(20).optional(),
      careerGoals: z.array(z.string().max(120)).max(10).optional(), password: z.string().optional(),
    }), req.body);
    authorize(auth, 'student:create', await orgUnitTarget(db, auth.tenantId, body.sectionId));
    return created(reply, await createStudent(db, actor(req), body));
  }));

  app.get('/students/me', async (req) => tx(req, async (db, auth) => ({ id: await myStudentId(db, auth) })));

  /** The 360° profile. Sensitive dimensions and raw evaluations are shown only to authorised staff. */
  app.get('/students/:id', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const target = await authorizeStudent(db, auth, 'student:view', id);
    void target;
    const isSelf = !!(await one(db, `SELECT 1 FROM students WHERE id = $1 AND user_id = $2`, [id, auth.userId]));
    const staff = auth.kind === 'staff';
    const s = await one<any>(db,
      `SELECT s.id, s.full_name, s.roll_no, s.enrollment_year, s.status, s.interests, s.career_goals, s.profile, s.created_at,
              sec.id AS section_id, sec.name AS section FROM students s JOIN org_units sec ON sec.id = s.section_id WHERE s.id = $1`, [id]);
    const [evidence, achievements, projects, events, interventions] = await Promise.all([
      many(db, `SELECT id, source, activity_type, title, verification_level, occurred_at FROM evidence WHERE student_id = $1 ORDER BY occurred_at DESC LIMIT 20`, [id]),
      many(db, `SELECT kind, key, title, awarded_at FROM achievements WHERE student_id = $1 ORDER BY awarded_at DESC`, [id]),
      many(db, `SELECT p.id, p.title, p.status, pm.role FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.student_id = $1`, [id]),
      many(db, `SELECT e.id, e.name, e.category, r.role, r.status FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.student_id = $1 ORDER BY r.created_at DESC LIMIT 10`, [id]),
      staff ? many(db, `SELECT id, kind, title, state, created_at FROM interventions WHERE student_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]) : Promise.resolve([]),
    ]);
    const evidenceMix = await many(db, `SELECT verification_level, count(*)::int AS n FROM evidence WHERE student_id = $1 GROUP BY 1`, [id]);
    const taskStats = await one(db,
      `SELECT count(*) FILTER (WHERE status IN ('submitted','evaluated'))::int AS completed, count(*)::int AS assigned
         FROM task_assignments WHERE student_id = $1 AND created_at > now() - interval '30 days'`, [id]);
    await audit(db, actor(req), { action: 'student.view', entityType: 'student', entityId: id, source: 'api' });
    return { profile: { ...s, profile: isSelf || staff ? s.profile : undefined }, evidence, evidenceMix, achievements, projects, events, interventions, taskStats };
  }));

  app.patch('/students/:id', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const isSelf = !!(await one(db, `SELECT 1 FROM students WHERE id = $1 AND user_id = $2`, [id, auth.userId]));
    // Students may edit their own interests/goals; everything else needs student:edit.
    const body = parse(z.object({ interests: z.array(z.string().max(60)).max(20).optional(), careerGoals: z.array(z.string().max(120)).max(10).optional(),
      fullName: z.string().min(1).max(200).optional(), sectionId: Uuid.optional(), status: z.enum(['active', 'inactive', 'graduated', 'withdrawn']).optional(),
      profile: z.record(z.string(), z.unknown()).optional() }), req.body);
    const adminFields = ['fullName', 'sectionId', 'status', 'profile'].filter((k) => (body as any)[k] !== undefined);
    if (adminFields.length || !isSelf) await authorizeStudent(db, auth, 'student:edit', id);
    const before = await one(db, `SELECT full_name, section_id, status, interests, career_goals, profile FROM students WHERE id = $1`, [id]);
    await db.query(
      `UPDATE students SET interests = COALESCE($2, interests), career_goals = COALESCE($3, career_goals), full_name = COALESCE($4, full_name),
              section_id = COALESCE($5, section_id), status = COALESCE($6, status), profile = COALESCE($7, profile) WHERE id = $1`,
      [id, body.interests ?? null, body.careerGoals ?? null, body.fullName ?? null, body.sectionId ?? null, body.status ?? null, body.profile ? JSON.stringify(body.profile) : null]);
    await audit(db, actor(req), { action: 'student.update', entityType: 'student', entityId: id, before, after: body });
    return { ok: true };
  }));

  app.post('/students/:id/guardians', async (req, reply) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    await authorizeStudent(db, auth, 'guardian:create', id);
    const body = parse(z.object({ email: z.string().email(), fullName: z.string().min(1), relationship: z.string().max(40).optional(), password: z.string().optional() }), req.body);
    return created(reply, await linkGuardian(db, actor(req), id, body));
  }));

  /** Teacher override of a skill level — always requires a reason and is audited. */
  app.put('/students/:id/skills/:skillId/override', async (req) => tx(req, async (db, auth) => {
    const { id, skillId } = parse(z.object({ id: Uuid, skillId: Uuid }), req.params);
    await authorizeStudent(db, auth, 'evaluation:evaluate', id);
    const body = parse(z.object({ proficiency: z.number().min(0).max(100).nullable(), reason: z.string().min(5).max(1000) }), req.body);
    if (!(await one(db, `SELECT 1 FROM skills WHERE id = $1`, [skillId]))) throw badRequest('Unknown skill');
    const before = await one<any>(db, `SELECT proficiency, teacher_override FROM student_skills WHERE student_id = $1 AND skill_id = $2`, [id, skillId]);
    const override = body.proficiency === null ? null : { proficiency: body.proficiency, reason: body.reason, by: auth.userId, at: new Date().toISOString() };
    await db.query(`INSERT INTO student_skills (student_id, skill_id, teacher_override) VALUES ($1,$2,$3)
                    ON CONFLICT (student_id, skill_id) DO UPDATE SET teacher_override = $3, updated_at = now()`, [id, skillId, override && JSON.stringify(override)]);
    await audit(db, actor(req), { action: 'skill.teacher_override', entityType: 'student_skill', entityId: `${id}:${skillId}`, before, after: override ?? { cleared: true, reason: body.reason } });
    await emit(db, 'growth.recalculate', 'student', id, { studentId: id, reason: 'teacher_override' });
    return { ok: true };
  }));
}
