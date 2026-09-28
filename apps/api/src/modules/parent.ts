/**
 * Parent portal: an understandable summary of the child's progress. Deliberately excludes
 * sensitive dimensions, raw AI evaluations, interventions/counselling and flagged-attendance detail.
 */
import type { FastifyInstance } from 'fastify';
import { many, one } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { actor, IdParams, parse, tx } from '../http/context.js';
import { audit } from '../lib/audit.js';
import { growthSummary } from '../services/growth.js';

export async function parentRoutes(app: FastifyInstance) {
  app.get('/parent/children', async (req) => tx(req, async (db, auth) => ({
    items: await many(db, `SELECT s.id, s.full_name, sec.name AS section FROM guardian_links gl JOIN students s ON s.id = gl.student_id
                            JOIN org_units sec ON sec.id = s.section_id WHERE gl.guardian_user_id = $1 AND gl.status = 'active'`, [auth.userId]),
  })));

  app.get('/parent/children/:id/summary', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const link = await one(db, `SELECT 1 FROM guardian_links WHERE guardian_user_id = $1 AND student_id = $2 AND status = 'active'`, [auth.userId, id]);
    if (!link) throw notFound('Student');
    const consent = await one<{ granted: boolean }>(db,
      `SELECT granted FROM consents WHERE subject_student_id = $1 AND purpose = 'guardian_sharing' ORDER BY created_at DESC LIMIT 1`, [id]);
    if (consent && !consent.granted) return { restricted: true, message: 'The student has limited what is shared with guardians under institution policy.' };
    const g = await growthSummary(db, id, false);
    const s = await one<any>(db, `SELECT full_name, career_goals FROM students WHERE id = $1`, [id]);
    const completion = await many(db,
      `SELECT date_trunc('week', created_at)::date AS week, count(*)::int AS assigned,
              count(*) FILTER (WHERE status IN ('submitted','evaluated'))::int AS completed
         FROM task_assignments WHERE student_id = $1 AND created_at > now() - interval '8 weeks' GROUP BY 1 ORDER BY 1`, [id]);
    const achievements = await many(db, `SELECT title, kind, awarded_at FROM achievements WHERE student_id = $1 ORDER BY awarded_at DESC LIMIT 10`, [id]);
    const participation = await many(db,
      `SELECT e.name, e.category, r.role FROM event_registrations r JOIN events e ON e.id = r.event_id
        WHERE r.student_id = $1 AND r.status = 'registered' ORDER BY r.created_at DESC LIMIT 10`, [id]);
    const verifiedAchievements = await many(db,
      `SELECT title, activity_type, occurred_at FROM evidence WHERE student_id = $1 AND verification_level = 'VERIFIED'
        AND activity_type IN ('certification','competition','volunteering','leadership','sports','cultural','research','internship','course','project')
        ORDER BY occurred_at DESC LIMIT 10`, [id]);
    const recs = await many(db, `SELECT title, rationale FROM recommendations WHERE student_id = $1 AND status = 'open' AND source IN ('rule','teacher') ORDER BY priority DESC LIMIT 3`, [id]);
    await audit(db, actor(req), { action: 'guardian.view_summary', entityType: 'student', entityId: id });
    return {
      student: { name: s.full_name, careerGoals: s.career_goals },
      growth: g.current ? { score: g.current.overall, evidenceConfidence: g.current.evidenceConfidence, change: g.growth?.change ?? null,
        areas: g.current.dimensions.filter((d: any) => d.score != null).map((d: any) => ({ name: d.name, score: d.score })) } : null,
      careerReadiness: g.current?.dimensions.find((d: any) => d.key === 'career')?.score ?? null,
      taskCompletion: completion, achievements, verifiedAchievements, participation, recommendations: recs,
    };
  }));
}
