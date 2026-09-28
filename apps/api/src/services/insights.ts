/**
 * Teacher-facing insights. Observations are factual trend statements generated from data and
 * validated against the neutral-language guard; they never label students.
 */
import { describeTrend, isNeutral } from '@s360/core';
import { many, type Db } from '../db/pool.js';

export interface Insight { studentId: string; studentName: string; kind: string; message: string; severity: 'info' | 'attention' }

export async function teacherInsights(db: Db, studentIds: string[] | null): Promise<Insight[]> {
  const weekly = await many<{ student_id: string; full_name: string; week: string; rate: number; n: number }>(db,
    `SELECT s.id AS student_id, s.full_name, date_trunc('week', a.due_at)::date AS week,
            avg(CASE WHEN a.status IN ('submitted','evaluated') THEN 100.0 ELSE 0 END)::float AS rate, count(*)::int AS n
       FROM task_assignments a JOIN students s ON s.id = a.student_id
      WHERE a.due_at BETWEEN now() - interval '28 days' AND now() AND ($1::uuid[] IS NULL OR s.id = ANY($1))
      GROUP BY s.id, s.full_name, week ORDER BY s.id, week`, [studentIds]);
  const byStudent = new Map<string, { name: string; rates: number[] }>();
  for (const w of weekly) {
    const e = byStudent.get(w.student_id) ?? { name: w.full_name, rates: [] };
    e.rates.push(Math.round(w.rate));
    byStudent.set(w.student_id, e);
  }
  const out: Insight[] = [];
  for (const [studentId, v] of byStudent) {
    if (v.rates.length >= 3) {
      const declining = v.rates.every((r, i) => i === 0 || r <= v.rates[i - 1]!) && v.rates[0]! - v.rates[v.rates.length - 1]! >= 20;
      if (declining) {
        const msg = describeTrend('Task completion', v.rates, '%', 'weeks');
        if (msg && isNeutral(msg)) out.push({ studentId, studentName: v.name, kind: 'completion_trend', message: msg, severity: 'attention' });
      }
    }
  }

  const drops = await many<{ student_id: string; full_name: string; skill: string; velocity: number; proficiency: number }>(db,
    `SELECT s.id AS student_id, s.full_name, sk.name AS skill, ss.velocity, ss.proficiency FROM student_skills ss
       JOIN students s ON s.id = ss.student_id JOIN skills sk ON sk.id = ss.skill_id JOIN growth_dimensions d ON d.id = sk.dimension_id
      WHERE ss.velocity <= -5 AND ss.confidence >= 0.3 AND NOT d.sensitive AND ($1::uuid[] IS NULL OR s.id = ANY($1))
      ORDER BY ss.velocity LIMIT 50`, [studentIds]);
  for (const d of drops) {
    out.push({ studentId: d.student_id, studentName: d.full_name, kind: 'skill_decline', severity: 'attention',
      message: `${d.skill} proficiency has decreased at about ${Math.abs(d.velocity).toFixed(0)} points per month (now ${d.proficiency.toFixed(0)}/100).` });
  }

  const stalled = await many<{ student_id: string; full_name: string; n: number }>(db,
    `SELECT s.id AS student_id, s.full_name, count(*)::int AS n FROM task_assignments a JOIN students s ON s.id = a.student_id
      WHERE a.status IN ('assigned','in_progress') AND a.due_at < now() AND a.due_at > now() - interval '14 days'
        AND ($1::uuid[] IS NULL OR s.id = ANY($1))
      GROUP BY s.id, s.full_name HAVING count(*) >= 3`, [studentIds]);
  for (const s of stalled) {
    out.push({ studentId: s.student_id, studentName: s.full_name, kind: 'overdue_tasks', severity: 'info',
      message: `${s.n} tasks passed their due date in the last two weeks without a submission.` });
  }
  return out;
}
