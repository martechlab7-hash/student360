/**
 * Growth recalculation. Runs in the background (debounced per student), never synchronously on
 * a student's request path. Replays the signal history so results are reproducible, respects
 * teacher overrides, and writes a daily snapshot for trend reporting.
 */
import {
  computeGrowth, DEFAULT_SCORING_CONFIG, detectPath, evidenceConfidence, growthDelta, levelForScore, recommendedDifficulty, replay,
  type ScoringConfig, type SkillScoreInput, type SkillSignal, type SkillState, type VerificationLevel,
} from '@s360/core';
import { many, one, withTenant, type Db } from '../db/pool.js';
import { emit } from '../lib/outbox.js';
import { generateRuleRecommendations } from './recommendations.js';

export async function loadScoringConfig(db: Db): Promise<ScoringConfig> {
  const cfg = await one<{ version: number; config: any }>(db, `SELECT version, config FROM scoring_configs WHERE active`);
  const dims = await many<{ key: string; weight: number; enabled: boolean; sensitive: boolean }>(
    db, `SELECT key, weight, enabled, sensitive FROM growth_dimensions ORDER BY sort`);
  return { ...DEFAULT_SCORING_CONFIG, ...(cfg?.config ?? {}), version: cfg?.version ?? 1, dimensions: dims };
}

/**
 * Recalculates a student's skills and growth snapshot. `asOf` (a date) replays only evidence up to
 * that day and writes that day's snapshot — used for backfills after a scoring-config change.
 */
export async function recalculateStudent(tenantId: string, studentId: string, asOf?: Date) {
  const cutoff = asOf ?? new Date();
  const day = cutoff.toISOString().slice(0, 10);
  const isToday = !asOf;
  return withTenant({ tenantId }, async (db) => {
    const student = await one(db, `SELECT id FROM students WHERE id = $1`, [studentId]);
    if (!student) return null;
    const cfg = await loadScoringConfig(db);

    // 1. Skills: replay signals.
    const signals = await many<{ skill_id: string; performance: number; difficulty: number; verification: VerificationLevel; weight: number; occurred_at: Date }>(
      db, `SELECT skill_id, performance, difficulty, verification, weight, occurred_at FROM skill_signals WHERE student_id = $1 AND occurred_at <= $2 ORDER BY occurred_at`, [studentId, cutoff]);
    const bySkill = new Map<string, SkillSignal[]>();
    for (const s of signals) {
      const arr = bySkill.get(s.skill_id) ?? [];
      arr.push({ performance: s.performance, difficulty: s.difficulty, verification: s.verification, weight: s.weight, at: new Date(s.occurred_at) });
      bySkill.set(s.skill_id, arr);
    }
    const skillRows = await many<{ id: string; parent_id: string | null; weight: number; dimension_key: string }>(
      db, `SELECT sk.id, sk.parent_id, sk.weight, d.key AS dimension_key FROM skills sk JOIN growth_dimensions d ON d.id = sk.dimension_id`);
    const overrides = new Map((await many<{ skill_id: string; teacher_override: any }>(
      db, `SELECT skill_id, teacher_override FROM student_skills WHERE student_id = $1 AND teacher_override IS NOT NULL`, [studentId]))
      .map((r) => [r.skill_id, r.teacher_override]));

    const states = new Map<string, SkillState>();
    for (const [skillId, sigs] of bySkill) {
      const st = replay(sigs);
      states.set(skillId, st);
      const rec = recommendedDifficulty(st);
      if (!isToday) continue; // historical replays never overwrite current skill state
      await db.query(
        `INSERT INTO student_skills (student_id, skill_id, proficiency, confidence, evidence_count, velocity, recent, last_assessed_at,
           current_difficulty, recommended_difficulty, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (student_id, skill_id) DO UPDATE SET proficiency = EXCLUDED.proficiency, confidence = EXCLUDED.confidence,
           evidence_count = EXCLUDED.evidence_count, velocity = EXCLUDED.velocity, recent = EXCLUDED.recent, last_assessed_at = EXCLUDED.last_assessed_at,
           current_difficulty = EXCLUDED.current_difficulty, recommended_difficulty = EXCLUDED.recommended_difficulty, updated_at = now()`,
        [studentId, skillId, st.proficiency, st.confidence, st.evidenceCount, st.velocity, JSON.stringify(st.recent), st.lastAssessedAt,
          levelForScore(st.proficiency), rec.level],
      );
    }

    // Parent skills without direct evidence derive from their children (skill graph roll-up).
    const children = new Map<string, string[]>();
    for (const s of skillRows) if (s.parent_id) children.set(s.parent_id, [...(children.get(s.parent_id) ?? []), s.id]);
    const effective = (id: string): { p: number; c: number } | null => {
      const o = overrides.get(id);
      const st = states.get(id);
      if (st) return { p: o?.proficiency ?? st.proficiency, c: st.confidence };
      if (o) return { p: o.proficiency, c: 0.5 };
      const kids = (children.get(id) ?? []).map(effective).filter((x): x is { p: number; c: number } => !!x);
      if (!kids.length) return null;
      return { p: kids.reduce((a, k) => a + k.p, 0) / kids.length, c: kids.reduce((a, k) => a + k.c, 0) / kids.length };
    };
    // Score leaf-most evidence: use top-level skills (roll-ups) to avoid double counting children.
    const inputs: SkillScoreInput[] = [];
    for (const s of skillRows.filter((x) => !x.parent_id)) {
      const e = effective(s.id);
      if (e) inputs.push({ skillId: s.id, dimensionKey: s.dimension_key, proficiency: e.p, confidence: e.c, weight: s.weight });
    }

    // 2. Engagement (capped low in the score): completion of assigned work in the last 30 days.
    const engagement = await many<{ key: string; rate: number }>(db,
      `SELECT d.key, avg(CASE WHEN a.status IN ('submitted','evaluated') THEN 1.0 ELSE 0.0 END)::float AS rate
         FROM task_assignments a JOIN task_templates t ON t.id = a.template_id JOIN growth_dimensions d ON d.id = t.dimension_id
        WHERE a.student_id = $1 AND a.created_at BETWEEN $2::timestamptz - interval '30 days' AND $2 AND a.status <> 'cancelled'
          AND (a.due_at IS NULL OR a.due_at < $2 OR a.status IN ('submitted','evaluated'))
        GROUP BY d.key`, [studentId, cutoff]);

    // 3. Evidence confidence over the last 180 days.
    const ev = await many<{ verification_level: VerificationLevel }>(db,
      `SELECT verification_level FROM evidence WHERE student_id = $1 AND occurred_at BETWEEN $2::timestamptz - interval '180 days' AND $2`, [studentId, cutoff]);
    const conf = evidenceConfidence(ev.map((e) => ({ verification: e.verification_level })));

    const result = computeGrowth(cfg, inputs, engagement.map((e) => ({ dimensionKey: e.key, rate: e.rate })), conf);
    const prev = await one<{ overall: number | null }>(db, `SELECT overall FROM growth_snapshots WHERE student_id = $1 AND snapshot_date < $2::date ORDER BY snapshot_date DESC LIMIT 1`, [studentId, day]);
    await db.query(
      `INSERT INTO growth_snapshots (student_id, snapshot_date, overall, evidence_confidence, dimensions, config_version)
       VALUES ($1, $6::date, $2, $3, $4, $5)
       ON CONFLICT (student_id, snapshot_date) DO UPDATE SET overall = EXCLUDED.overall, evidence_confidence = EXCLUDED.evidence_confidence,
         dimensions = EXCLUDED.dimensions, config_version = EXCLUDED.config_version, created_at = now()`,
      [studentId, result.overall, result.evidenceConfidence, JSON.stringify(result.dimensions), result.configVersion, day]);
    if (!isToday) return result;

    // 4. Next-best-action recommendations from rules (explainable).
    const paths = [...states.entries()].map(([skillId, st]) => ({ skillId, path: detectPath(st), state: st }));
    await generateRuleRecommendations(db, studentId, paths);

    if (prev?.overall != null && result.overall != null && Math.floor(result.overall / 10) > Math.floor(prev.overall / 10)) {
      await emit(db, 'growth.updated', 'student', studentId, { studentId, milestone: Math.floor(result.overall / 10) * 10 });
    }
    return result;
  });
}

export async function growthSummary(db: Db, studentId: string, includeSensitive: boolean) {
  const snaps = await many<{ snapshot_date: string; overall: number | null; evidence_confidence: number; dimensions: any[]; created_at: Date }>(
    db, `SELECT snapshot_date, overall, evidence_confidence, dimensions, created_at FROM growth_snapshots
          WHERE student_id = $1 AND snapshot_date > current_date - 180 ORDER BY snapshot_date`, [studentId]);
  const dims = await many<{ key: string; name: string; sensitive: boolean; enabled: boolean }>(db, `SELECT key, name, sensitive, enabled FROM growth_dimensions ORDER BY sort`);
  const visible = new Map(dims.filter((d) => d.enabled && (includeSensitive || !d.sensitive)).map((d) => [d.key, d.name]));
  const current = snaps[snaps.length - 1] ?? null;
  const monthAgo = [...snaps].reverse().find((s) => new Date(s.snapshot_date) <= new Date(Date.now() - 28 * 86400_000)) ?? snaps[0] ?? null;
  const delta = current ? growthDelta({ overall: current.overall, at: new Date(current.snapshot_date) },
    monthAgo && monthAgo !== current ? { overall: monthAgo.overall, at: new Date(monthAgo.snapshot_date) } : null) : null;
  const skills = await many(db,
    `SELECT sk.id, sk.key, sk.name, sk.parent_id, d.key AS dimension, ss.proficiency, ss.confidence, ss.evidence_count, ss.velocity,
            ss.last_assessed_at, ss.current_difficulty, ss.recommended_difficulty, ss.teacher_override
       FROM student_skills ss JOIN skills sk ON sk.id = ss.skill_id JOIN growth_dimensions d ON d.id = sk.dimension_id
      WHERE ss.student_id = $1 AND ($2 OR NOT d.sensitive) ORDER BY ss.proficiency DESC`, [studentId, includeSensitive]);
  return {
    current: current ? {
      overall: current.overall, evidenceConfidence: current.evidence_confidence, date: current.snapshot_date,
      dimensions: current.dimensions.filter((d: any) => visible.has(d.key)).map((d: any) => ({ ...d, name: visible.get(d.key) })),
    } : null,
    growth: delta,
    history: snaps.map((s) => ({ date: s.snapshot_date, overall: s.overall, evidenceConfidence: s.evidence_confidence })),
    skills,
  };
}

/**
 * Baseline → final measured improvement per skill, from STANDARDIZED assessments only.
 * This — not task counts — is the institution's outcome metric.
 */
export async function measuredImprovement(db: Db, studentIds: string[] | null) {
  return many(db,
    `WITH scored AS (
       SELECT sub.student_id, unnest(t.skill_ids) AS skill_id, t.assessment_kind, e.score, sub.submitted_at
         FROM evaluations e JOIN task_submissions sub ON sub.id = e.submission_id
         JOIN task_assignments a ON a.id = sub.assignment_id JOIN task_templates t ON t.id = a.template_id
        WHERE e.is_final AND t.assessment_kind IN ('baseline','final') AND t.mode = 'STANDARDIZED'
          AND ($1::uuid[] IS NULL OR sub.student_id = ANY($1))
     ), paired AS (
       SELECT student_id, skill_id,
              (array_agg(score ORDER BY submitted_at) FILTER (WHERE assessment_kind = 'baseline'))[1] AS baseline,
              (array_agg(score ORDER BY submitted_at DESC) FILTER (WHERE assessment_kind = 'final'))[1] AS final
         FROM scored GROUP BY student_id, skill_id
     )
     SELECT sk.name AS skill, count(*)::int AS students, round(avg(baseline), 1) AS avg_baseline, round(avg(final), 1) AS avg_final,
            round(avg(final - baseline), 1) AS avg_improvement,
            count(*) FILTER (WHERE final > baseline)::int AS improved
       FROM paired p JOIN skills sk ON sk.id = p.skill_id
      WHERE baseline IS NOT NULL AND final IS NOT NULL
      GROUP BY sk.name ORDER BY avg_improvement DESC`, [studentIds]);
}
