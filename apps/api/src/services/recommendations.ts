/**
 * Explainable next-best-action engine. Every recommendation carries a rationale grounded in the
 * student's data. Rule recommendations are deduplicated so re-running the job is harmless.
 */
import type { ProgressionPath, SkillState } from '@s360/core';
import { many, one, type Db } from '../db/pool.js';
import { emit } from '../lib/outbox.js';

async function upsertRec(db: Db, studentId: string, r: { kind: string; title: string; body?: string; rationale: string; action?: unknown; priority: number; dedupeKey: string; source?: string }) {
  const res = await db.query(
    `INSERT INTO recommendations (student_id, kind, title, body, action, rationale, source, priority, dedupe_key, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + interval '14 days')
     ON CONFLICT (tenant_id, student_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'open'
     DO UPDATE SET rationale = EXCLUDED.rationale, priority = EXCLUDED.priority
     RETURNING (xmax = 0) AS inserted, id`,
    [studentId, r.kind, r.title, r.body ?? null, JSON.stringify(r.action ?? {}), r.rationale, r.source ?? 'rule', r.priority, r.dedupeKey]);
  if (res.rows[0]?.inserted) await emit(db, 'recommendation.created', 'recommendation', res.rows[0].id, { studentId, title: r.title });
}

export async function generateRuleRecommendations(db: Db, studentId: string, paths: { skillId: string; path: ProgressionPath; state: SkillState }[]) {
  const names = new Map((await many<{ id: string; name: string }>(db, `SELECT id, name FROM skills`)).map((s) => [s.id, s.name]));

  for (const p of paths) {
    const name = names.get(p.skillId) ?? 'this skill';
    if (p.path === 'remediation') {
      await upsertRec(db, studentId, {
        kind: 'practice', title: `Focused practice: ${name}`, priority: 90, dedupeKey: `remediate:${p.skillId}`,
        rationale: `Your last ${Math.min(3, p.state.recent.length)} ${name} attempts were below 50%. A short, simpler practice set followed by a re-check usually helps.`,
        action: { type: 'remedial_practice', skillId: p.skillId },
      });
    } else if (p.path === 'advanced') {
      await upsertRec(db, studentId, {
        kind: 'project', title: `Take ${name} further with a project`, priority: 70, dedupeKey: `advance:${p.skillId}`,
        rationale: `You have scored 95%+ on your last ${Math.min(3, p.state.recent.length)} ${name} tasks. Applying it in a real project or mentoring a peer is the next step.`,
        action: { type: 'advanced_path', skillId: p.skillId },
      });
    }
  }

  // Lowest measured skill with reasonable confidence.
  const weakest = [...paths].filter((p) => p.state.confidence >= 0.3 && p.state.proficiency < 60).sort((a, b) => a.state.proficiency - b.state.proficiency)[0];
  if (weakest && weakest.path === 'standard') {
    const name = names.get(weakest.skillId) ?? 'skill';
    await upsertRec(db, studentId, {
      kind: 'practice', title: `Daily practice: ${name}`, priority: 60, dedupeKey: `gap:${weakest.skillId}`,
      rationale: `${name} is currently your lowest measured skill (${weakest.state.proficiency.toFixed(0)}/100). Ten minutes a day on it will have the biggest effect on your growth score.`,
      action: { type: 'practice', skillId: weakest.skillId },
    });
  }

  // Upcoming events aligned to the weakest dimension.
  if (weakest) {
    const ev = await one<{ id: string; name: string }>(db,
      `SELECT e.id, e.name FROM events e JOIN skills sk ON sk.id = $2
        WHERE e.status = 'published' AND (e.dimension_id = sk.dimension_id OR $2 = ANY(e.skill_ids))
          AND EXISTS (SELECT 1 FROM event_sessions es WHERE es.event_id = e.id AND es.starts_at > now())
          AND NOT EXISTS (SELECT 1 FROM event_registrations r WHERE r.event_id = e.id AND r.student_id = $1)
        LIMIT 1`, [studentId, weakest.skillId]);
    if (ev) {
      await upsertRec(db, studentId, {
        kind: 'event', title: `Join: ${ev.name}`, priority: 50, dedupeKey: `event:${ev.id}`,
        rationale: `This event practises ${names.get(weakest.skillId)}, which is a current development area for you.`,
        action: { type: 'register_event', eventId: ev.id },
      });
    }
  }
}

export async function nextBestActions(db: Db, studentId: string) {
  const tasks = await many(db,
    `SELECT a.id, a.content->>'title' AS title, a.rationale, a.due_at, t.type FROM task_assignments a JOIN task_templates t ON t.id = a.template_id
      WHERE a.student_id = $1 AND a.status IN ('assigned','in_progress') AND (a.start_at IS NULL OR a.start_at <= now())
      ORDER BY a.due_at NULLS LAST, a.created_at LIMIT 3`, [studentId]);
  const recs = await many(db,
    `SELECT id, kind, title, rationale, action FROM recommendations WHERE student_id = $1 AND status = 'open' AND (expires_at IS NULL OR expires_at > now())
      ORDER BY priority DESC, created_at DESC LIMIT 3`, [studentId]);
  return {
    actions: [
      ...tasks.map((t: any) => ({ type: 'task', id: t.id, title: t.title, why: t.rationale, dueAt: t.due_at })),
      ...recs.map((r: any) => ({ type: 'recommendation', id: r.id, title: r.title, why: r.rationale, action: r.action })),
    ],
  };
}
