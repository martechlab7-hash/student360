import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runPrompt } from '../ai/gateway.js';
import { many } from '../db/pool.js';
import { actor, authorize, authorizeStudent, created, parse, requireAnywhere, requireAuth, tx, Uuid, perMinute } from '../http/context.js';
import { myStudentId } from '../http/scope.js';
import { draftTasks, interviewTurn, mentorChat } from '../services/mentor.js';
import { withTenant } from '../db/pool.js';
import { orgUnitTarget } from '../auth/principal.js';

export async function aiRoutes(app: FastifyInstance) {
  const aiLimit = { rateLimit: perMinute(20) };

  app.post('/ai/mentor', { config: aiLimit }, async (req) => {
    const body = parse(z.object({ message: z.string().min(1).max(4000), conversationId: Uuid.optional() }), req.body);
    const studentId = await tx(req, (db, auth) => myStudentId(db, auth));
    return mentorChat(requireAuth(req), studentId, body.message, body.conversationId);
  });

  app.post('/ai/interview', { config: aiLimit }, async (req) => {
    const body = parse(z.object({ kind: z.enum(['hr', 'technical', 'behavioral', 'role_specific']), role: z.string().min(2).max(120),
      answer: z.string().max(8000).optional(), conversationId: Uuid.optional() }), req.body);
    const studentId = await tx(req, (db, auth) => myStudentId(db, auth));
    return interviewTurn(requireAuth(req), studentId, body);
  });

  app.post('/ai/teacher/tasks', { config: aiLimit }, async (req, reply) => {
    const body = parse(z.object({ request: z.string().min(5).max(2000), skillIds: z.array(Uuid).min(1).max(5), type: z.string(),
      level: z.enum(['beginner', 'basic', 'intermediate', 'advanced', 'expert']), count: z.number().int().min(1).max(10), sectionIds: z.array(Uuid).min(1) }), req.body);
    const auth = requireAuth(req);
    requireAnywhere(auth, 'ai:create');
    await tx(req, async (db) => {
      for (const s of body.sectionIds) authorize(auth, 'task:create', await orgUnitTarget(db, auth.tenantId, s));
    });
    return created(reply, await draftTasks(auth, actor(req), body));
  });

  app.post('/ai/content/transform', { config: aiLimit }, async (req) => {
    const auth = requireAuth(req);
    const body = parse(z.object({ mode: z.enum(['summary', 'quiz', 'micro_tasks', 'learning_path']), source: z.string().min(20).max(60_000) }), req.body);
    const r = await runPrompt({ tenantId: auth.tenantId, userId: auth.userId }, 'contentTransform', body);
    // Stored as a draft content item; a teacher reviews before publishing.
    const id = await withTenant({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const row = await db.query(`INSERT INTO content_items (kind, title, body, ai_generated, status, created_by) VALUES ($1,$2,$3,true,'pending_review',$4) RETURNING id`,
        [body.mode, r.output.title, JSON.stringify({ ...r.output, interactionId: r.interactionId }), auth.userId]);
      return row.rows[0].id as string;
    });
    return { contentId: id, ...r.output, status: 'pending_review' };
  });

  app.get('/ai/usage', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'ai:manage_ai', null);
    return {
      byFeature: await many(db, `SELECT feature, model, count(*)::int AS calls, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens,
                                        round(sum(cost_usd)::numeric, 4) AS cost_usd, round(avg(latency_ms))::int AS avg_latency_ms,
                                        count(*) FILTER (WHERE status <> 'succeeded')::int AS failures
                                   FROM ai_interactions WHERE created_at > now() - interval '30 days' GROUP BY feature, model ORDER BY calls DESC`),
    };
  }));

  app.get('/ai/evaluations/:studentId', async (req) => tx(req, async (db, auth) => {
    const { studentId } = parse(z.object({ studentId: Uuid }), req.params);
    await authorizeStudent(db, auth, 'evaluation:view', studentId);
    return { items: await many(db,
      `SELECT e.id, e.submission_id, e.model, e.prompt_version, e.rubric_version, e.score, e.status, e.is_final, e.created_at,
              o.id AS overridden_by, o.score AS final_score, o.override_reason
         FROM evaluations e JOIN task_submissions sub ON sub.id = e.submission_id
         LEFT JOIN evaluations o ON o.overrides_id = e.id
        WHERE e.evaluator_type = 'ai' AND sub.student_id = $1 ORDER BY e.created_at DESC LIMIT 100`, [studentId]) };
  }));
}
