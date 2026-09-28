/**
 * Evaluation pipeline. Scores are always computed server-side; client-supplied scores are never
 * trusted. AI evaluations record model, prompt version and rubric version, and teachers can
 * override any evaluation (audited, the original is preserved).
 */
import { compositeDifficulty, getTaskType, type VerificationLevel } from '@s360/core';
import { runPrompt } from '../ai/gateway.js';
import type { AuthContext } from '../auth/principal.js';
import { many, one, withTenant, type Db } from '../db/pool.js';
import { audit, type AuditActor } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { emit } from '../lib/outbox.js';
import { getCodeRunner } from '../sandbox/runner.js';

const AI_MIN_CONFIDENCE = 0.6;

interface SubmissionCtx {
  id: string; student_id: string; payload: any; status: string; assignment_id: string; content: any; difficulty_profile: any;
  type: string; config: any; rubric: any[]; rubric_version: number; template_id: string; template_content: any;
}

async function loadSubmission(db: Db, submissionId: string) {
  return one<SubmissionCtx>(db,
    `SELECT sub.id, sub.student_id, sub.payload, sub.status, sub.assignment_id, a.content, a.difficulty_profile,
            t.type, t.config, t.rubric, t.rubric_version, t.id AS template_id, t.content AS template_content
       FROM task_submissions sub JOIN task_assignments a ON a.id = sub.assignment_id JOIN task_templates t ON t.id = a.template_id
      WHERE sub.id = $1`, [submissionId]);
}

function autoGrade(type: string, answerKey: any, payload: any): { score: number; criteria: unknown[] } {
  if (type === 'mcq') {
    const correct = payload.answerIndex === answerKey.answerIndex;
    return { score: correct ? 100 : 0, criteria: [{ name: 'Correct answer', score: correct ? 1 : 0, maxScore: 1 }] };
  }
  const qs = (answerKey.questions ?? []) as { answerIndex: number }[];
  const answers = (payload.answers ?? []) as number[];
  const criteria = qs.map((q, i) => ({ name: `Q${i + 1}`, score: answers[i] === q.answerIndex ? 1 : 0, maxScore: 1 }));
  const right = criteria.filter((c) => c.score === 1).length;
  return { score: qs.length ? (right / qs.length) * 100 : 0, criteria };
}

/** Job: evaluate a submission. Idempotent — does nothing if an evaluation already exists. */
export async function evaluateSubmission(tenantId: string, submissionId: string): Promise<void> {
  const sub = await withTenant({ tenantId }, async (db) => {
    const s = await loadSubmission(db, submissionId);
    if (!s || s.status !== 'submitted') return null;
    const existing = await one(db, `SELECT 1 FROM evaluations WHERE submission_id = $1 AND status <> 'failed'`, [submissionId]);
    if (existing) return null;
    await db.query(`UPDATE task_submissions SET status = 'evaluating' WHERE id = $1`, [submissionId]);
    return s;
  });
  if (!sub) return;

  const def = getTaskType(sub.type);
  const strategy: string = sub.config.evaluation ?? (sub.config.aiEvaluation === false && def?.defaultEvaluation === 'ai' ? 'teacher' : def?.defaultEvaluation ?? 'teacher');
  const needsTeacher = sub.config.teacherReview === true;

  let evaluation: {
    evaluator_type: string; score: number | null; criteria: unknown[]; output: unknown; status: 'completed' | 'needs_review' | 'pending';
    model?: string; prompt_version?: string; ai_interaction_id?: string;
  };

  try {
    if (strategy === 'auto') {
      const key = sub.template_content; // answer keys stay on the template, never on the student-facing assignment
      const g = autoGrade(sub.type, key, sub.payload);
      evaluation = { evaluator_type: 'auto', score: g.score, criteria: g.criteria, output: {}, status: needsTeacher ? 'needs_review' : 'completed' };
    } else if (strategy === 'sandbox') {
      const runner = getCodeRunner();
      const tests = sub.template_content?.testCases ?? [];
      if (!runner || tests.length === 0) {
        evaluation = { evaluator_type: 'teacher', score: null, criteria: [], output: { reason: runner ? 'no test cases' : 'sandbox not configured' }, status: 'pending' };
      } else {
        const r = await runner.run(sub.payload.language, sub.payload.code, tests);
        evaluation = { evaluator_type: 'sandbox', score: (r.passed / r.total) * 100, criteria: r.results.map((x, i) => ({ name: `Test ${i + 1}`, score: x.passed ? 1 : 0, maxScore: 1, status: x.status })),
          output: { passed: r.passed, total: r.total }, status: needsTeacher ? 'needs_review' : 'completed' };
      }
    } else if (strategy === 'ai' || strategy === 'ai_then_teacher') {
      const text = sub.payload.text ?? sub.payload.transcript ?? sub.payload.code ?? sub.payload.note ?? '';
      const isTranscript = !sub.payload.text && !!sub.payload.transcript;
      const ai = await runPrompt({ tenantId, studentId: sub.student_id, inputRef: `task_submission:${sub.id}` }, 'evaluateRubric', {
        type: sub.type, taskPrompt: sub.content?.prompt ?? '', rubric: sub.rubric, rubricVersion: sub.rubric_version, submission: text,
        inputNote: isTranscript ? 'The submission is an automatic speech-to-text transcript; audio features such as pronunciation are not observable.' : undefined,
      });
      // Never trust model arithmetic: clamp each criterion to its rubric maximum and total server-side.
      const rubricMax = new Map<string, number>((sub.rubric ?? []).map((c: any) => [c.name, c.maxPoints]));
      const criteria = ai.output.criteria.map((c) => {
        const max = rubricMax.get(c.name) ?? c.maxScore;
        return { ...c, maxScore: max, score: Math.max(0, Math.min(max, c.score)) };
      });
      const max = [...rubricMax.values()].reduce((a, b) => a + b, 0) || criteria.reduce((a, c) => a + c.maxScore, 0) || 1;
      const score = (criteria.reduce((a, c) => a + c.score, 0) / max) * 100;
      const review = strategy === 'ai_then_teacher' || needsTeacher || ai.output.flagForHumanReview || ai.output.confidence < AI_MIN_CONFIDENCE;
      evaluation = { evaluator_type: 'ai', score, criteria, output: ai.output, status: review ? 'needs_review' : 'completed',
        model: ai.model, prompt_version: `${ai.promptKey}@${ai.promptVersion}`, ai_interaction_id: ai.interactionId };
    } else if (strategy === 'system') {
      evaluation = { evaluator_type: 'system', score: 100, criteria: [], output: { note: 'Completion verified by system' }, status: 'completed' };
    } else {
      evaluation = { evaluator_type: 'teacher', score: null, criteria: [], output: {}, status: 'pending' };
    }
  } catch (err) {
    // AI or sandbox unavailable: route to a human instead of failing the student's work.
    const reason = err instanceof AppError ? err.code : 'EVALUATION_ERROR';
    evaluation = { evaluator_type: 'teacher', score: null, criteria: [], output: { reason, message: (err as Error).message }, status: 'pending' };
  }

  await withTenant({ tenantId }, async (db) => {
    const final = evaluation.status === 'completed';
    const e = await one<{ id: string }>(db,
      `INSERT INTO evaluations (submission_id, evaluator_type, ai_interaction_id, model, prompt_version, rubric, rubric_version, input_ref,
         output, score, criteria, status, is_final)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [sub.id, evaluation.evaluator_type, evaluation.ai_interaction_id ?? null, evaluation.model ?? null, evaluation.prompt_version ?? null,
        JSON.stringify(sub.rubric ?? []), sub.rubric_version, `task_submission:${sub.id}`, JSON.stringify(evaluation.output),
        evaluation.score, JSON.stringify(evaluation.criteria), evaluation.status, final]);
    await db.query(`UPDATE task_submissions SET status = $2 WHERE id = $1`, [sub.id, final ? 'evaluated' : 'needs_review']);
    if (final) await emit(db, 'evaluation.finalized', 'evaluation', e!.id, { studentId: sub.student_id, submissionId: sub.id });
    else await emit(db, 'evaluation.needs_review', 'evaluation', e!.id, { studentId: sub.student_id, submissionId: sub.id });
  });
}

/** Teacher evaluates (or overrides an AI/auto evaluation). The previous evaluation is kept for audit. */
export async function teacherEvaluate(
  db: Db, auth: AuthContext, actor: AuditActor, submissionId: string,
  input: { score: number; feedback?: string; criteria?: unknown[]; reason?: string },
) {
  if (input.score < 0 || input.score > 100) throw badRequest('score must be between 0 and 100');
  const sub = await loadSubmission(db, submissionId);
  if (!sub) throw notFound('Submission');
  const prior = await one<any>(db,
    `SELECT id, evaluator_type, score, is_final FROM evaluations WHERE submission_id = $1 ORDER BY is_final DESC, created_at DESC LIMIT 1`, [submissionId]);
  if (prior?.is_final && !input.reason) throw badRequest('A reason is required when overriding a final evaluation');
  await db.query(`UPDATE evaluations SET is_final = false WHERE submission_id = $1 AND is_final`, [submissionId]);
  await db.query(`UPDATE evaluations SET status = 'completed' WHERE submission_id = $1 AND status IN ('pending','needs_review')`, [submissionId]);
  const e = await one<{ id: string }>(db,
    `INSERT INTO evaluations (submission_id, evaluator_type, evaluator_user_id, rubric, rubric_version, output, score, criteria, status, is_final, overrides_id, override_reason)
     VALUES ($1,'teacher',$2,$3,$4,$5,$6,$7,'completed',true,$8,$9) RETURNING id`,
    [submissionId, auth.userId, JSON.stringify(sub.rubric ?? []), sub.rubric_version, JSON.stringify({ feedback: input.feedback ?? null }),
      input.score, JSON.stringify(input.criteria ?? []), prior?.id ?? null, input.reason ?? null]);
  await db.query(`UPDATE task_submissions SET status = 'evaluated' WHERE id = $1`, [submissionId]);
  await audit(db, actor, {
    action: prior ? 'evaluation.override' : 'evaluation.create', entityType: 'task_submission', entityId: submissionId,
    before: prior ? { evaluationId: prior.id, evaluator: prior.evaluator_type, score: prior.score } : undefined,
    after: { evaluationId: e!.id, score: input.score, reason: input.reason },
  });
  await emit(db, 'evaluation.finalized', 'evaluation', e!.id, { studentId: sub.student_id, submissionId });
  return { evaluationId: e!.id };
}

/**
 * Job: apply a final evaluation to the growth model — evidence record + skill signals.
 * Idempotent via UNIQUE(evidence activity ref) and UNIQUE(skill_signals source, skill); a
 * teacher override simply replaces the signal for the same submission.
 */
export async function applyEvaluation(tenantId: string, evaluationId: string): Promise<void> {
  await withTenant({ tenantId }, async (db) => {
    const e = await one<any>(db,
      `SELECT e.*, sub.student_id, sub.assignment_id, sub.submitted_at, a.difficulty_profile, a.content, t.type, t.title, t.skill_ids,
              t.dimension_id, t.assessment_kind, t.config
         FROM evaluations e JOIN task_submissions sub ON sub.id = e.submission_id
         JOIN task_assignments a ON a.id = sub.assignment_id JOIN task_templates t ON t.id = a.template_id
        WHERE e.id = $1`, [evaluationId]);
    if (!e || !e.is_final || e.score == null) return;
    const def = getTaskType(e.type);
    // AI-only scoring of in-platform work is trusted less than auto/sandbox/teacher scoring.
    const verification: VerificationLevel = e.evaluator_type === 'ai' ? 'PARTIALLY_VERIFIED' : 'VERIFIED';

    await db.query(
      `INSERT INTO evidence (student_id, source, activity_type, activity_ref_type, activity_ref_id, title, data, dimension_id, skill_ids,
         verification_level, confidence, occurred_at, verified_at)
       VALUES ($1,$2,$3,'task_submission',$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $9 = 'VERIFIED' THEN now() END)
       ON CONFLICT (tenant_id, student_id, activity_ref_type, activity_ref_id) WHERE activity_ref_id IS NOT NULL
       DO UPDATE SET data = EXCLUDED.data, verification_level = EXCLUDED.verification_level, confidence = EXCLUDED.confidence`,
      [e.student_id, def?.evidenceSource ?? 'system', e.type, e.submission_id, e.content?.title ?? e.title,
        JSON.stringify({ evaluationId: e.id, score: e.score, evaluator: e.evaluator_type, assessmentKind: e.assessment_kind }),
        e.dimension_id, e.skill_ids, verification, verification === 'VERIFIED' ? 0.95 : 0.7, e.submitted_at],
    );

    const weight = (def?.signalWeight ?? 1) * (e.assessment_kind && e.assessment_kind !== 'formative' ? 2 : 1) * (def?.competencySignal === false ? 0.2 : 1);
    for (const skillId of e.skill_ids as string[]) {
      await db.query(
        `INSERT INTO skill_signals (student_id, skill_id, source_type, source_id, performance, difficulty, verification, weight, occurred_at)
         VALUES ($1,$2,'task_submission',$3,$4,$5,$6,$7,$8)
         ON CONFLICT (source_type, source_id, skill_id) DO UPDATE SET performance = EXCLUDED.performance, verification = EXCLUDED.verification, weight = EXCLUDED.weight`,
        [e.student_id, skillId, e.submission_id, Number(e.score) / Number(e.max_score), compositeDifficulty(e.difficulty_profile), verification, weight, e.submitted_at],
      );
    }
    const pass = Number(e.score) >= (e.config?.passingScore ?? 50);
    await db.query(`UPDATE task_assignments SET status = 'evaluated' WHERE id = $1`, [e.assignment_id]);
    await emit(db, 'growth.recalculate', 'student', e.student_id, { studentId: e.student_id, reason: 'evaluation', passed: pass });
  });
}

export async function pendingReviews(db: Db, studentIds: string[] | null, limit = 50) {
  return many(db,
    `SELECT DISTINCT ON (sub.id) sub.id AS submission_id, sub.submitted_at, sub.payload, s.id AS student_id, s.full_name, t.title, t.type, t.rubric,
            a.content->>'prompt' AS prompt, e.id AS evaluation_id, e.evaluator_type, e.score AS suggested_score, e.output AS ai_output, e.status
       FROM task_submissions sub JOIN students s ON s.id = sub.student_id
       JOIN task_assignments a ON a.id = sub.assignment_id JOIN task_templates t ON t.id = a.template_id
       LEFT JOIN evaluations e ON e.submission_id = sub.id
      WHERE sub.status = 'needs_review' AND ($1::uuid[] IS NULL OR s.id = ANY($1))
      ORDER BY sub.id, e.created_at DESC LIMIT $2`, [studentIds, limit]);
}
