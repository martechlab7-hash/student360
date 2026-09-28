/** Evidence Engine: every achievement is backed by a record with a verification level. */
import type { FastifyInstance } from 'fastify';
import { canTransition, VERIFICATION_LEVELS } from '@s360/core';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { emit } from '../lib/outbox.js';
import { actor, authorizeStudent, created, IdParams, parse, tx, Uuid } from '../http/context.js';
import { myStudentId, visibleStudentIds } from '../http/scope.js';

export async function evidenceRoutes(app: FastifyInstance) {
  app.get('/students/:id/evidence', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    await authorizeStudent(db, auth, 'evidence:view', id);
    return { items: await many(db,
      `SELECT e.id, e.source, e.activity_type, e.title, e.description, e.verification_level, e.confidence, e.occurred_at, e.file_ref, e.data,
              d.name AS dimension, (SELECT json_agg(json_build_object('from', v.from_level, 'to', v.to_level, 'at', v.created_at, 'note', v.note) ORDER BY v.created_at)
                                     FROM evidence_verifications v WHERE v.evidence_id = e.id) AS history
         FROM evidence e LEFT JOIN growth_dimensions d ON d.id = e.dimension_id WHERE e.student_id = $1 ORDER BY e.occurred_at DESC LIMIT 200`, [id]) };
  }));

  /** Students can submit genuine external achievements. They start SELF_REPORTED and never count as verified until reviewed. */
  app.post('/evidence', async (req, reply) => tx(req, async (db, auth) => {
    const body = parse(z.object({
      title: z.string().min(3).max(200), description: z.string().max(5000).optional(),
      activityType: z.enum(['certification', 'competition', 'volunteering', 'leadership', 'sports', 'cultural', 'research', 'internship', 'course', 'other']),
      dimensionKey: z.string().optional(), skillIds: z.array(Uuid).max(10).default([]), occurredAt: z.coerce.date().optional(),
      fileRef: z.string().max(500).optional(), externalUrl: z.string().url().max(500).optional(), studentId: Uuid.optional(),
    }), req.body);
    let studentId: string;
    let level: 'SELF_REPORTED' | 'VERIFIED' = 'SELF_REPORTED';
    if (body.studentId) {
      // Staff recording evidence on behalf of a student (e.g. event coordinator) — teacher-verified.
      await authorizeStudent(db, auth, 'evidence:create', body.studentId);
      studentId = body.studentId;
      if (auth.kind === 'staff') level = 'VERIFIED';
    } else {
      studentId = await myStudentId(db, auth);
    }
    const dim = body.dimensionKey ? await one<{ id: string }>(db, `SELECT id FROM growth_dimensions WHERE key = $1`, [body.dimensionKey]) : null;
    if (body.dimensionKey && !dim) throw badRequest('Unknown dimension');
    const e = await one<{ id: string }>(db,
      `INSERT INTO evidence (student_id, source, activity_type, title, description, data, file_ref, dimension_id, skill_ids, verification_level,
         confidence, occurred_at, created_by, verified_by, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [studentId, level === 'VERIFIED' ? 'teacher' : 'self_report', body.activityType, body.title, body.description ?? null,
        JSON.stringify({ externalUrl: body.externalUrl }), body.fileRef ?? null, dim?.id ?? null, body.skillIds, level,
        level === 'VERIFIED' ? 0.9 : 0.25, body.occurredAt ?? new Date(), auth.userId, level === 'VERIFIED' ? auth.userId : null, level === 'VERIFIED' ? new Date() : null]);
    await audit(db, actor(req), { action: 'evidence.create', entityType: 'evidence', entityId: e!.id, after: { ...body, level } });
    await emit(db, 'growth.recalculate', 'student', studentId, { studentId, reason: 'evidence' });
    return created(reply, { id: e!.id, verificationLevel: level });
  }));

  /** Review queue of unverified evidence in the caller's scope. */
  app.get('/evidence/review', async (req) => tx(req, async (db, auth) => {
    const ids = await visibleStudentIds(db, auth, 'evidence:approve');
    if (ids && ids.length === 0) return { items: [] };
    return { items: await many(db,
      `SELECT e.id, e.student_id, s.full_name, e.title, e.activity_type, e.verification_level, e.occurred_at, e.file_ref, e.data
         FROM evidence e JOIN students s ON s.id = e.student_id
        WHERE e.verification_level <> 'VERIFIED' AND e.activity_ref_type IS NULL AND ($1::uuid[] IS NULL OR e.student_id = ANY($1))
        ORDER BY e.created_at LIMIT 100`, [ids]) };
  }));

  app.post('/evidence/:id/verify', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ level: z.enum(VERIFICATION_LEVELS), note: z.string().max(1000).optional() }), req.body);
    const e = await one<any>(db, `SELECT id, student_id, verification_level FROM evidence WHERE id = $1 FOR UPDATE`, [id]);
    if (!e) throw notFound('Evidence');
    await authorizeStudent(db, auth, 'evidence:approve', e.student_id);
    const isSelf = !!(await one(db, `SELECT 1 FROM students WHERE id = $1 AND user_id = $2`, [e.student_id, auth.userId]));
    // Holding evidence:approve over the student (checked above) makes the caller a verifier — but never for their own evidence.
    if (!canTransition(e.verification_level, body.level, !isSelf)) throw badRequest('Invalid verification change');
    await db.query(`UPDATE evidence SET verification_level = $2, verified_by = $3, verified_at = now(),
                      confidence = CASE $2 WHEN 'VERIFIED' THEN 0.95 WHEN 'PARTIALLY_VERIFIED' THEN 0.6 ELSE 0.25 END WHERE id = $1`, [id, body.level, auth.userId]);
    await db.query(`INSERT INTO evidence_verifications (evidence_id, from_level, to_level, actor_id, note) VALUES ($1,$2,$3,$4,$5)`,
      [id, e.verification_level, body.level, auth.userId, body.note ?? null]);
    await audit(db, actor(req), { action: 'evidence.verify', entityType: 'evidence', entityId: id, before: { level: e.verification_level }, after: body });
    await emit(db, 'evidence.verified', 'student', e.student_id, { studentId: e.student_id });
    return { ok: true };
  }));
}
