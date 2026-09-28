/**
 * AI Student Mentor, AI Interviewer and AI Teacher Assistant.
 * The mentor returns *actions* (persisted as recommendations with rationale), not just chat.
 * Context sent to the model is pseudonymous: no names, emails or identifiers beyond opaque ids.
 */
import { runPrompt } from '../ai/gateway.js';
import type { AuthContext } from '../auth/principal.js';
import { many, one, withTenant, type Db } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import type { AuditActor } from '../lib/audit.js';
import { createTemplate, TemplateInput } from './tasks.js';

async function studentContext(db: Db, studentId: string) {
  const s = await one<any>(db, `SELECT interests, career_goals, enrollment_year FROM students WHERE id = $1`, [studentId]);
  if (!s) throw notFound('Student');
  const skills = await many<{ skill: string; proficiency: number; confidence: number; velocity: number }>(db,
    `SELECT sk.name AS skill, ss.proficiency, ss.confidence, ss.velocity FROM student_skills ss JOIN skills sk ON sk.id = ss.skill_id
      JOIN growth_dimensions d ON d.id = sk.dimension_id WHERE ss.student_id = $1 AND NOT d.sensitive ORDER BY ss.proficiency`, [studentId]);
  const pendingTasks = await many(db,
    `SELECT a.id, a.content->>'title' AS title, a.due_at, a.rationale FROM task_assignments a
      WHERE a.student_id = $1 AND a.status IN ('assigned','in_progress') ORDER BY a.due_at NULLS LAST LIMIT 5`, [studentId]);
  const recent = await many(db,
    `SELECT t.title, e.score, e.output->'improvements' AS improvements, sub.submitted_at FROM evaluations e
       JOIN task_submissions sub ON sub.id = e.submission_id JOIN task_assignments a ON a.id = sub.assignment_id
       JOIN task_templates t ON t.id = a.template_id
      WHERE sub.student_id = $1 AND e.is_final ORDER BY sub.submitted_at DESC LIMIT 5`, [studentId]);
  const snap = await one(db, `SELECT overall, evidence_confidence FROM growth_snapshots WHERE student_id = $1 ORDER BY snapshot_date DESC LIMIT 1`, [studentId]);
  return {
    goals: s.career_goals, interests: s.interests, year: s.enrollment_year, growthScore: snap?.overall ?? null, evidenceConfidence: snap?.evidence_confidence ?? null,
    strengths: skills.slice(-3).reverse().map((x) => ({ skill: x.skill, proficiency: x.proficiency })),
    gaps: skills.filter((x) => x.confidence >= 0.2).slice(0, 3).map((x) => ({ skill: x.skill, proficiency: x.proficiency })),
    pendingTasks, recentResults: recent,
  };
}

export async function mentorChat(auth: AuthContext, studentId: string, message: string, conversationId?: string) {
  const { context, history, convId } = await withTenant({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
    let convId = conversationId;
    if (convId) {
      const c = await one(db, `SELECT id FROM ai_conversations WHERE id = $1 AND student_id = $2 AND kind = 'mentor'`, [convId, studentId]);
      if (!c) throw notFound('Conversation');
    } else {
      convId = (await one<{ id: string }>(db, `INSERT INTO ai_conversations (student_id, user_id, kind) VALUES ($1,$2,'mentor') RETURNING id`, [studentId, auth.userId]))!.id;
    }
    const history = await many<{ role: 'user' | 'assistant'; content: string }>(db,
      `SELECT role, content FROM (SELECT role, content, created_at FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10) x ORDER BY created_at`, [convId]);
    return { context: await studentContext(db, studentId), history, convId: convId! };
  });

  const ai = await runPrompt({ tenantId: auth.tenantId, userId: auth.userId, studentId, inputRef: `ai_conversation:${convId}` },
    'mentor', { context, history, message });

  return withTenant({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
    await db.query(`INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,'user',$2)`, [convId, message]);
    await db.query(`INSERT INTO ai_messages (conversation_id, role, content, meta) VALUES ($1,'assistant',$2,$3)`,
      [convId, ai.output.reply, JSON.stringify({ actions: ai.output.actions, interactionId: ai.interactionId })]);
    for (const a of ai.output.actions.filter((x) => x.kind !== 'start_task')) {
      await db.query(
        `INSERT INTO recommendations (student_id, kind, title, rationale, source, action, priority, dedupe_key, expires_at)
         VALUES ($1,$2,$3,$4,'ai',$5,40,$6, now() + interval '7 days')
         ON CONFLICT (tenant_id, student_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'open' DO NOTHING`,
        [studentId, a.kind, a.title, a.reason, JSON.stringify(a), `ai:${a.kind}:${a.title.toLowerCase().slice(0, 60)}`]);
    }
    return { conversationId: convId, reply: ai.output.reply, actions: ai.output.actions };
  });
}

export async function interviewTurn(auth: AuthContext, studentId: string, input: { kind: string; role: string; answer?: string; conversationId?: string }) {
  const { convId, history } = await withTenant({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
    let convId = input.conversationId;
    if (!convId) {
      convId = (await one<{ id: string }>(db, `INSERT INTO ai_conversations (student_id, user_id, kind, meta) VALUES ($1,$2,'interview',$3) RETURNING id`,
        [studentId, auth.userId, JSON.stringify({ kind: input.kind, role: input.role })]))!.id;
    } else if (!(await one(db, `SELECT 1 FROM ai_conversations WHERE id = $1 AND student_id = $2`, [convId, studentId]))) {
      throw notFound('Interview');
    }
    if (input.answer) await db.query(`INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,'user',$2)`, [convId, input.answer]);
    const history = await many<{ role: string; content: string }>(db, `SELECT role, content FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at`, [convId]);
    return { convId: convId!, history };
  });
  const ai = await runPrompt({ tenantId: auth.tenantId, userId: auth.userId, studentId }, 'interviewTurn', { kind: input.kind, role: input.role, history });
  await withTenant({ tenantId: auth.tenantId, userId: auth.userId }, (db) =>
    db.query(`INSERT INTO ai_messages (conversation_id, role, content, meta) VALUES ($1,'assistant',$2,$3)`,
      [convId, ai.output.question, JSON.stringify({ followUpReason: ai.output.followUpReason, done: ai.output.done })]));
  return { conversationId: convId, question: ai.output.question, done: ai.output.done };
}

/** Teacher assistant: AI drafts tasks which are saved as pending_review — never auto-published. */
export async function draftTasks(auth: AuthContext, actor: AuditActor, input: { request: string; skillIds: string[]; type: string; level: string; count: number; sectionIds: string[] }) {
  const skills = await withTenant({ tenantId: auth.tenantId, userId: auth.userId }, (db) =>
    many<{ id: string; name: string; dimension_id: string }>(db, `SELECT id, name, dimension_id FROM skills WHERE id = ANY($1)`, [input.skillIds]));
  const ai = await runPrompt({ tenantId: auth.tenantId, userId: auth.userId }, 'teacherTasks',
    { request: input.request, skills: skills.map((s) => s.name), type: input.type, level: input.level, count: input.count });
  return withTenant({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
    const ids: string[] = [];
    for (const t of ai.output.tasks.slice(0, input.count)) {
      const parsed = TemplateInput.safeParse({
        type: input.type, title: t.title, objective: t.objective, instructions: t.instructions, content: t.content,
        skillIds: input.skillIds, dimensionId: skills[0]?.dimension_id, difficultyLevel: t.difficultyLevel, mode: 'EQUIVALENT',
        rubric: t.rubric.length ? t.rubric : undefined, target: { sectionIds: input.sectionIds, studentIds: [] },
        config: { durationMinutes: Math.round(t.estimatedMinutes) || undefined },
      });
      if (!parsed.success) continue; // invalid drafts are dropped, not published
      ids.push(await createTemplate(db, actor, parsed.data, 'ai'));
    }
    return { draftTemplateIds: ids, interactionId: ai.interactionId, note: 'Drafts require teacher review before publishing.' };
  });
}
