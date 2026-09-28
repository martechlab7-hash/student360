import {
  compositeDifficulty, decideProgression, getTaskType, isEquivalent, parseDifficultyProfile, profileForLevel,
  type DifficultyLevel, type DifficultyProfile, type SkillState, type TaskMode,
} from '@s360/core';
import { z } from 'zod';
import { runPrompt } from '../ai/gateway.js';
import type { AuthContext } from '../auth/principal.js';
import { many, one, withTenant, type Db } from '../db/pool.js';
import { audit, type AuditActor } from '../lib/audit.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { emit } from '../lib/outbox.js';
import { CONTENT_SCHEMAS, DEFAULT_RUBRICS, SUBMISSION_SCHEMAS } from './taskSchemas.js';

export const TaskConfigSchema = z.object({
  attempts: z.number().int().min(1).max(20).default(1),
  passingScore: z.number().min(0).max(100).default(50),
  durationMinutes: z.number().int().min(1).max(600).optional(),
  evidenceRequired: z.boolean().default(true),
  evaluation: z.enum(['auto', 'ai', 'teacher', 'sandbox', 'system', 'ai_then_teacher']).optional(),
  aiEvaluation: z.boolean().default(true),
  teacherReview: z.boolean().default(false),
  adaptiveDifficulty: z.boolean().default(true),
  maxLevelShift: z.number().int().min(0).max(4).default(1),
}).default({ attempts: 1, passingScore: 50, evidenceRequired: true, aiEvaluation: true, teacherReview: false, adaptiveDifficulty: true, maxLevelShift: 1 });

export const TemplateInput = z.object({
  type: z.string().refine((t) => !!getTaskType(t), 'Unknown task type'),
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(2000),
  instructions: z.string().max(10_000).optional(),
  content: z.record(z.string(), z.unknown()).default({}),
  topic: z.string().max(200).optional(),
  dimensionId: z.string().uuid().optional(),
  skillIds: z.array(z.string().uuid()).max(10).default([]),
  difficultyLevel: z.enum(['beginner', 'basic', 'intermediate', 'advanced', 'expert']),
  difficultyProfile: z.record(z.string(), z.number()).optional(),
  mode: z.enum(['STANDARDIZED', 'EQUIVALENT', 'ADAPTIVE', 'PERSONALIZED']).default('EQUIVALENT'),
  config: TaskConfigSchema,
  rubric: z.array(z.object({ name: z.string(), description: z.string(), maxPoints: z.number().positive() })).optional(),
  assessmentKind: z.enum(['baseline', 'formative', 'final']).optional(),
  target: z.object({ sectionIds: z.array(z.string().uuid()).default([]), studentIds: z.array(z.string().uuid()).default([]) })
    .default({ sectionIds: [], studentIds: [] }),
  startAt: z.coerce.date().optional(),
  dueAt: z.coerce.date().optional(),
});
export type TemplateInputT = z.infer<typeof TemplateInput>;

export async function createTemplate(db: Db, actor: AuditActor, input: TemplateInputT, source: 'teacher' | 'ai' | 'journey' = 'teacher') {
  const contentSchema = CONTENT_SCHEMAS[input.type];
  if (contentSchema && Object.keys(input.content).length) {
    const r = contentSchema.safeParse(input.content);
    if (!r.success) throw badRequest('Invalid content for task type', r.error.issues);
  }
  if (input.assessmentKind && input.assessmentKind !== 'formative' && input.mode !== 'STANDARDIZED') {
    throw badRequest('Baseline and final assessments must use STANDARDIZED mode so results are comparable');
  }
  const profile = input.difficultyProfile ? parseDifficultyProfile(input.difficultyProfile) : profileForLevel(input.difficultyLevel);
  if (!profile) throw badRequest('difficultyProfile must contain all seven difficulty axes');
  const rubric = input.rubric ?? DEFAULT_RUBRICS[input.type] ?? DEFAULT_RUBRICS.default;
  if (input.skillIds.length) {
    const found = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM skills WHERE id = ANY($1)`, [input.skillIds]);
    if (found!.n !== input.skillIds.length) throw badRequest('One or more skills not found');
  }
  const t = await one<{ id: string }>(
    db,
    `INSERT INTO task_templates (type, title, objective, instructions, content, topic, dimension_id, skill_ids, difficulty_level,
       difficulty_profile, mode, config, rubric, assessment_kind, status, source, target, start_at, due_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [input.type, input.title, input.objective, input.instructions ?? null, JSON.stringify(input.content), input.topic ?? null,
      input.dimensionId ?? null, input.skillIds, input.difficultyLevel, JSON.stringify(profile), input.mode, JSON.stringify(input.config),
      JSON.stringify(rubric), input.assessmentKind ?? null, source === 'ai' ? 'pending_review' : 'draft', source,
      JSON.stringify(input.target), input.startAt ?? null, input.dueAt ?? null, actor.userId ?? null],
  );
  await audit(db, actor, { action: 'task_template.create', entityType: 'task_template', entityId: t!.id, after: { title: input.title, mode: input.mode, source } });
  return t!.id;
}

export async function publishTemplate(db: Db, actor: AuditActor, templateId: string) {
  const t = await one<{ status: string; target: any; source: string }>(db, `SELECT status, target, source FROM task_templates WHERE id = $1 FOR UPDATE`, [templateId]);
  if (!t) throw notFound('Task template');
  if (t.status === 'published') return { alreadyPublished: true };
  if (t.status === 'archived') throw conflict('Archived templates cannot be published');
  if (!t.target.sectionIds?.length && !t.target.studentIds?.length) throw unprocessable('Task has no target students');
  await db.query(`UPDATE task_templates SET status = 'published', published_at = now(), approved_by = $2 WHERE id = $1`, [templateId, actor.userId ?? null]);
  await audit(db, actor, { action: 'task_template.publish', entityType: 'task_template', entityId: templateId, before: { status: t.status }, after: { status: 'published' } });
  await emit(db, 'task.published', 'task_template', templateId);
  return { alreadyPublished: false };
}

interface TemplateRow {
  id: string; type: string; title: string; objective: string; instructions: string | null; content: any; topic: string | null;
  skill_ids: string[]; difficulty_level: DifficultyLevel; difficulty_profile: DifficultyProfile; mode: TaskMode; config: z.infer<typeof TaskConfigSchema>;
  target: { sectionIds: string[]; studentIds: string[] }; start_at: Date | null; due_at: Date | null; status: string;
}

/**
 * Job: create a personalised assignment for every targeted student. Idempotent — students who
 * already have an assignment for this template are skipped (UNIQUE(template_id, student_id)).
 * Each student is processed in its own transaction so one AI failure never blocks the class.
 */
export async function generateAssignments(tenantId: string, templateId: string, concurrency = 6): Promise<{ created: number; skipped: number; fallbacks: number }> {
  const { template, students, skills } = await withTenant({ tenantId }, async (db) => {
    const template = await one<TemplateRow>(db, `SELECT * FROM task_templates WHERE id = $1`, [templateId]);
    if (!template || template.status !== 'published') return { template: null, students: [], skills: [] };
    const students = await many<{ id: string; interests: string[] }>(
      db,
      `SELECT s.id, s.interests FROM students s JOIN org_units sec ON sec.id = s.section_id
        WHERE s.status = 'active' AND (sec.path && $1::uuid[] OR s.id = ANY($2::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM task_assignments a WHERE a.template_id = $3 AND a.student_id = s.id)`,
      [template.target.sectionIds ?? [], template.target.studentIds ?? [], templateId],
    );
    const skills = await many<{ id: string; name: string }>(db, `SELECT id, name FROM skills WHERE id = ANY($1)`, [template.skill_ids]);
    return { template, students, skills };
  });
  if (!template) return { created: 0, skipped: 0, fallbacks: 0 };

  let created = 0, fallbacks = 0;
  const queue = [...students];
  const usedTopics: string[] = [];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const r = await assignOne(tenantId, template, skills, s, usedTopics);
      if (r.created) created++;
      if (r.fallback) fallbacks++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  return { created, skipped: 0, fallbacks };
}

async function assignOne(
  tenantId: string, t: TemplateRow, skills: { id: string; name: string }[], student: { id: string; interests: string[] }, usedTopics: string[],
) {
  const primarySkill = skills[0];
  // Phase 1 (short transaction): read the student's ability state and recent diagnostics.
  const { skillState, failedConcepts, previous } = await withTenant({ tenantId }, async (db) => {
    const ss = primarySkill ? await one<any>(db, `SELECT * FROM student_skills WHERE student_id = $1 AND skill_id = $2`, [student.id, primarySkill.id]) : null;
    const skillState: SkillState | null = ss ? {
      proficiency: ss.teacher_override?.proficiency ?? ss.proficiency, confidence: ss.confidence, evidenceCount: ss.evidence_count,
      velocity: ss.velocity, lastAssessedAt: ss.last_assessed_at, recent: ss.recent ?? [],
    } : null;
    const failedConcepts = primarySkill ? (await many<{ c: string }>(db,
      `SELECT DISTINCT jsonb_array_elements_text(e.output->'conceptsMissed') AS c
         FROM evaluations e JOIN task_submissions sub ON sub.id = e.submission_id
         JOIN task_assignments a ON a.id = sub.assignment_id JOIN task_templates tt ON tt.id = a.template_id
        WHERE sub.student_id = $1 AND e.is_final AND $2 = ANY(tt.skill_ids) AND e.created_at > now() - interval '30 days'
        LIMIT 5`, [student.id, primarySkill.id])).map((r) => r.c) : [];
    const previous = (await many<{ q: string }>(db,
      `SELECT a.content->>'question' AS q FROM task_assignments a JOIN task_templates tt ON tt.id = a.template_id
        WHERE a.student_id = $1 AND tt.skill_ids && $2::uuid[] AND a.content ? 'question' ORDER BY a.created_at DESC LIMIT 20`,
      [student.id, t.skill_ids])).map((p) => p.q);
    return { skillState, failedConcepts, previous };
  });

  const decision = decideProgression({
    mode: t.mode, teacherLevel: t.difficulty_level, adaptiveDifficulty: t.config.adaptiveDifficulty, maxLevelShift: t.config.maxLevelShift,
    skill: skillState, skillName: primarySkill?.name ?? t.title, recentFailedConcepts: failedConcepts,
  });
  const targetProfile = decision.targetLevel === t.difficulty_level ? t.difficulty_profile : profileForLevel(decision.targetLevel);

  let content: any = { ...t.content, prompt: t.instructions ?? t.objective, title: t.title };
  const generation: Record<string, unknown> = { personalized: false, targetComposite: compositeDifficulty(targetProfile) };
  let fallback = false;

  // Phase 2 (no transaction held): AI authors a variant; it is accepted only if its difficulty
  // profile is equivalent to the target. Auto-graded types keep teacher-authored answer keys.
  if (decision.personalizeContent && getTaskType(t.type)?.defaultEvaluation !== 'auto') {
    const avoid = [...previous, ...usedTopics.slice(-30)];
    for (let attempt = 0; attempt < 3 && !generation.personalized; attempt++) {
      try {
        const ai = await runPrompt({ tenantId, studentId: student.id, inputRef: `task_template:${t.id}` }, 'taskVariant', {
          type: t.type, skills: skills.map((s) => ({ name: s.name })), objective: t.objective, topic: t.topic, targetLevel: decision.targetLevel,
          targetProfile, path: decision.path, failedConcepts, interests: student.interests.slice(0, 5), avoid, baseContent: t.content,
          variantKey: student.id.slice(0, 8),
        });
        const eq = isEquivalent(targetProfile, ai.output.difficultyProfile);
        // Checked synchronously after the await, so concurrent workers cannot both claim a topic.
        const topic = ai.output.content.question ?? ai.output.title;
        const duplicate = usedTopics.includes(topic);
        generation.lastCheck = { attempt, ...eq, duplicate, interactionId: ai.interactionId };
        if (eq.ok && !duplicate) {
          content = { ...t.content, ...ai.output.content, prompt: ai.output.prompt, title: ai.output.title,
            conceptsAssessed: ai.output.conceptsAssessed, expectedDurationMinutes: ai.output.expectedDurationMinutes };
          Object.assign(generation, { personalized: true, interactionId: ai.interactionId, model: ai.model, promptVersion: ai.promptVersion,
            generatedComposite: compositeDifficulty(ai.output.difficultyProfile) });
          usedTopics.push(topic);
        } else {
          avoid.push(topic);
        }
      } catch (e) {
        generation.error = (e as Error).message;
        break;
      }
    }
    if (!generation.personalized) { fallback = true; generation.fallback = 'template_content'; }
  }

  // Phase 3 (short transaction): idempotent insert.
  return withTenant({ tenantId }, async (db) => {
    const r = await db.query(
      `INSERT INTO task_assignments (template_id, student_id, content, difficulty_level, difficulty_profile, path, rationale, status, generation, start_at, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'assigned',$8,$9,$10) ON CONFLICT (template_id, student_id) DO NOTHING RETURNING id`,
      [t.id, student.id, JSON.stringify(content), decision.targetLevel, JSON.stringify(targetProfile), decision.path, decision.rationale,
        JSON.stringify(generation), t.start_at, t.due_at],
    );
    if (r.rowCount) await emit(db, 'task.assigned', 'task_assignment', r.rows[0].id, { studentId: student.id, templateId: t.id, title: content.title });
    return { created: !!r.rowCount, fallback };
  });
}

export async function submit(db: Db, auth: AuthContext, assignmentId: string, payload: unknown) {
  const a = await one<any>(db,
    `SELECT a.*, t.type, t.config, s.user_id AS student_user_id FROM task_assignments a
       JOIN task_templates t ON t.id = a.template_id JOIN students s ON s.id = a.student_id
      WHERE a.id = $1 FOR UPDATE OF a`, [assignmentId]);
  if (!a || a.student_user_id !== auth.userId) throw notFound('Task');
  if (!['assigned', 'in_progress', 'evaluated'].includes(a.status)) throw conflict(`Task cannot be submitted in state ${a.status}`);
  if (a.due_at && new Date(a.due_at) < new Date() && !a.config.allowLate) throw conflict('The due date for this task has passed');
  if (a.attempts_used >= (a.config.attempts ?? 1)) throw conflict('No attempts remaining');
  const schema = SUBMISSION_SCHEMAS[a.type];
  if (!schema) throw badRequest(`Submissions are not supported for ${a.type}`);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw badRequest('Invalid submission', parsed.error.issues);

  const attempt = a.attempts_used + 1;
  const sub = await one<{ id: string }>(db,
    `INSERT INTO task_submissions (assignment_id, student_id, attempt_no, payload) VALUES ($1,$2,$3,$4) RETURNING id`,
    [assignmentId, a.student_id, attempt, JSON.stringify(parsed.data)]);
  await db.query(`UPDATE task_assignments SET status = 'submitted', attempts_used = $2 WHERE id = $1`, [assignmentId, attempt]);
  await emit(db, 'submission.created', 'task_submission', sub!.id, { studentId: a.student_id });
  return { submissionId: sub!.id, attempt };
}
