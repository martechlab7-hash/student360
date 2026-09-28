/** Role home screens and analytics. Aggregates are read from snapshots, never recomputed per request. */
import type { FastifyInstance } from 'fastify';
import { can } from '@s360/core';
import { z } from 'zod';
import { orgUnitTarget } from '../auth/principal.js';
import { many, one } from '../db/pool.js';
import { authorize, parse, requireAnywhere, tx, Uuid } from '../http/context.js';
import { myStudentId, visibleStudentIds } from '../http/scope.js';
import { pendingReviews } from '../services/evaluation.js';
import { growthSummary } from '../services/growth.js';
import { teacherInsights } from '../services/insights.js';
import { nextBestActions } from '../services/recommendations.js';

export async function dashboardRoutes(app: FastifyInstance) {
  /** Student home: Today's Growth. */
  app.get('/dashboard/student', async (req) => tx(req, async (db, auth) => {
    const id = await myStudentId(db, auth);
    const [growth, next, events, achievements] = await Promise.all([
      growthSummary(db, id, false),
      nextBestActions(db, id),
      many(db, `SELECT e.id, e.name, e.category, min(es.starts_at) AS starts_at FROM events e JOIN event_sessions es ON es.event_id = e.id
                 WHERE e.status = 'published' AND es.starts_at > now() GROUP BY e.id ORDER BY starts_at LIMIT 5`),
      many(db, `SELECT kind, title, awarded_at FROM achievements WHERE student_id = $1 ORDER BY awarded_at DESC LIMIT 5`, [id]),
    ]);
    return { studentId: id, growth, nextActions: next.actions, upcomingEvents: events, achievements };
  }));

  /** Teacher home: My Students + Actions Required. */
  app.get('/dashboard/teacher', async (req) => tx(req, async (db, auth) => {
    requireAnywhere(auth, 'student:view');
    const ids = await visibleStudentIds(db, auth, 'student:view');
    const scoped = ids ?? null;
    if (scoped && scoped.length === 0) return { students: [], pendingEvaluations: [], insights: [], classes: [], summary: null };
    const classes = await many(db,
      `SELECT sec.id, sec.name, count(s.id)::int AS students, round(avg(g.overall), 1) AS avg_growth
         FROM students s JOIN org_units sec ON sec.id = s.section_id
         LEFT JOIN LATERAL (SELECT overall FROM growth_snapshots gs WHERE gs.student_id = s.id ORDER BY snapshot_date DESC LIMIT 1) g ON true
        WHERE ($1::uuid[] IS NULL OR s.id = ANY($1)) GROUP BY sec.id, sec.name ORDER BY sec.name`, [scoped]);
    const gaps = await many(db,
      `SELECT sk.name AS skill, round(avg(ss.proficiency), 1) AS avg_proficiency, count(*)::int AS students,
              count(*) FILTER (WHERE ss.proficiency < 50)::int AS below_50
         FROM student_skills ss JOIN skills sk ON sk.id = ss.skill_id JOIN growth_dimensions d ON d.id = sk.dimension_id
        WHERE NOT d.sensitive AND ($1::uuid[] IS NULL OR ss.student_id = ANY($1)) GROUP BY sk.name ORDER BY avg_proficiency LIMIT 8`, [scoped]);
    const summary = await one(db,
      `SELECT count(*) FILTER (WHERE status IN ('submitted','evaluated'))::int AS completed, count(*)::int AS assigned
         FROM task_assignments WHERE created_at > now() - interval '7 days' AND ($1::uuid[] IS NULL OR student_id = ANY($1))`, [scoped]);
    const interventions = await many(db, `SELECT i.id, i.title, i.state, s.full_name FROM interventions i JOIN students s ON s.id = i.student_id
                                          WHERE i.state NOT IN ('closed','cancelled') AND ($1::uuid[] IS NULL OR i.student_id = ANY($1)) ORDER BY i.updated_at DESC LIMIT 10`, [scoped]);
    return {
      classes, skillGaps: gaps, weekSummary: summary, interventions,
      pendingEvaluations: await pendingReviews(db, scoped, 20),
      insights: await teacherInsights(db, scoped),
    };
  }));

  /** Admin home: Institutional Outcomes. */
  app.get('/dashboard/admin', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'analytics:view', null);
    const [health, byDept, engagement, ai, integrations] = await Promise.all([
      one(db, `WITH latest AS (SELECT DISTINCT ON (student_id) student_id, overall, evidence_confidence FROM growth_snapshots ORDER BY student_id, snapshot_date DESC),
                    month_ago AS (SELECT DISTINCT ON (student_id) student_id, overall FROM growth_snapshots WHERE snapshot_date <= current_date - 28 ORDER BY student_id, snapshot_date DESC)
               SELECT (SELECT count(*)::int FROM students WHERE status = 'active') AS active_students,
                      round(avg(l.overall), 1) AS avg_growth, round(avg(l.evidence_confidence))::int AS avg_evidence_confidence,
                      round(avg(l.overall - m.overall), 1) AS avg_change_28d
                 FROM latest l LEFT JOIN month_ago m USING (student_id)`),
      many(db, `SELECT dept.id, dept.name, count(DISTINCT s.id)::int AS students, round(avg(g.overall), 1) AS avg_growth
                  FROM org_units dept JOIN org_units sec ON dept.id = ANY(sec.path) AND sec.type = 'section'
                  JOIN students s ON s.section_id = sec.id
                  LEFT JOIN LATERAL (SELECT overall FROM growth_snapshots gs WHERE gs.student_id = s.id ORDER BY snapshot_date DESC LIMIT 1) g ON true
                 WHERE dept.type = 'department' GROUP BY dept.id, dept.name ORDER BY dept.name`),
      one(db, `SELECT count(DISTINCT student_id)::int AS active_last_7d, count(*)::int AS submissions_last_7d FROM task_submissions WHERE submitted_at > now() - interval '7 days'`),
      one(db, `SELECT count(*)::int AS calls_30d, round(coalesce(sum(cost_usd), 0)::numeric, 2) AS cost_30d,
                      count(*) FILTER (WHERE status <> 'succeeded')::int AS failures_30d FROM ai_interactions WHERE created_at > now() - interval '30 days'`),
      many(db, `SELECT kind, status, count(*)::int AS n FROM sync_jobs WHERE created_at > now() - interval '7 days' GROUP BY kind, status`),
    ]);
    const interventions = await one(db,
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE state IN ('evaluated','closed'))::int AS evaluated,
              round(avg((outcome->>'improvement')::numeric) FILTER (WHERE outcome ? 'improvement'), 1) AS avg_improvement FROM interventions`);
    return { institutionHealth: health, departments: byDept, engagement, interventions, ai, integrations,
      note: 'Outcomes are measured change; comparisons between groups show correlation, not proven causation.' };
  }));

  /** Aggregates for any org unit (section → department → campus) the caller can see. */
  app.get('/analytics/units/:id', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(z.object({ id: Uuid }), req.params);
    const target = await orgUnitTarget(db, auth.tenantId, id);
    if (!target || !can(auth.principal, 'analytics:view', target)) authorize(auth, 'analytics:view', null);
    const trend = await many(db,
      `SELECT date_trunc('week', gs.snapshot_date)::date AS week, round(avg(gs.overall), 1) AS avg_growth, round(avg(gs.evidence_confidence))::int AS avg_confidence
         FROM growth_snapshots gs JOIN students s ON s.id = gs.student_id JOIN org_units sec ON sec.id = s.section_id
        WHERE sec.path @> ARRAY[$1]::uuid[] AND gs.snapshot_date > current_date - 120 GROUP BY 1 ORDER BY 1`, [id]);
    const dims = await many(db,
      `SELECT d->>'key' AS dimension, round(avg((d->>'score')::numeric), 1) AS avg_score
         FROM (SELECT DISTINCT ON (gs.student_id) gs.dimensions FROM growth_snapshots gs JOIN students s ON s.id = gs.student_id
                 JOIN org_units sec ON sec.id = s.section_id WHERE sec.path @> ARRAY[$1]::uuid[] ORDER BY gs.student_id, gs.snapshot_date DESC) x,
              jsonb_array_elements(x.dimensions) d
        WHERE d->>'score' IS NOT NULL AND d->>'key' NOT IN (SELECT key FROM growth_dimensions WHERE sensitive) GROUP BY 1 ORDER BY 2`, [id]);
    const completion = await one(db,
      `SELECT count(*) FILTER (WHERE a.status IN ('submitted','evaluated'))::int AS completed, count(*)::int AS assigned
         FROM task_assignments a JOIN students s ON s.id = a.student_id JOIN org_units sec ON sec.id = s.section_id
        WHERE sec.path @> ARRAY[$1]::uuid[] AND a.created_at > now() - interval '30 days'`, [id]);
    return { growthTrend: trend, dimensions: dims, taskCompletion30d: completion };
  }));
}
