/** Notifications, integrations, audit log, privacy, projects and operational health. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, withTenant } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { sha256, stableStringify } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { emit } from '../lib/outbox.js';
import { actor, authorize, authorizeStudent, created, IdParams, parse, requireAnywhere, requireAuth, tx, Uuid } from '../http/context.js';
import { myStudentId } from '../http/scope.js';
import type { JobBus } from '../jobs/bus.js';

export async function miscRoutes(app: FastifyInstance, opts: { bus: JobBus }) {
  // ── Notifications ──────────────────────────────────────────────
  app.get('/notifications', async (req) => tx(req, async (db, auth) => ({
    items: await many(db, `SELECT id, kind, title, body, data, status, read_at, created_at FROM notifications
                            WHERE user_id = $1 AND channel = 'in_app' ORDER BY created_at DESC LIMIT 50`, [auth.userId]),
  })));
  app.post('/notifications/:id/read', async (req) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    await db.query(`UPDATE notifications SET status = 'read', read_at = now() WHERE id = $1 AND user_id = $2`, [id, auth.userId]);
    return { ok: true };
  }));

  // ── Integration hub: idempotent student import ─────────────────
  const ImportBody = z.object({
    system: z.string().regex(/^[a-z0-9_-]{2,40}$/),
    records: z.array(z.object({ externalId: z.string().min(1).max(100), fullName: z.string().min(1).max(200), email: z.string().email().optional(),
      sectionCode: z.string().min(1).max(50), rollNo: z.string().max(50).optional(), enrollmentYear: z.number().int().optional() })).min(1).max(5000),
  });
  app.post('/integrations/students/import', async (req, reply) => {
    const auth = requireAuth(req);
    authorize(auth, 'integration:manage_integrations', null);
    const body = parse(ImportBody, req.body);
    // The same payload (or an explicit Idempotency-Key) always maps to the same sync job.
    const key = (req.headers['idempotency-key'] as string | undefined) ?? sha256(stableStringify(body));
    const job = await withTenant({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const r = await db.query(`INSERT INTO sync_jobs (kind, idempotency_key, stats, created_by) VALUES ('student_import', $1, $2, $3)
                                ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
        [key, JSON.stringify({ total: body.records.length }), auth.userId]);
      if (!r.rowCount) return { id: (await one<{ id: string }>(db, `SELECT id FROM sync_jobs WHERE idempotency_key = $1`, [key]))!.id, duplicate: true };
      await audit(db, actor(req), { action: 'integration.import_requested', entityType: 'sync_job', entityId: r.rows[0].id, after: { system: body.system, count: body.records.length } });
      return { id: r.rows[0].id as string, duplicate: false };
    });
    if (!job.duplicate) await opts.bus.enqueue('integration.import_students', { tenantId: auth.tenantId, syncJobId: job.id, system: body.system, records: body.records, userId: auth.userId }, { jobId: `sync:${job.id}` });
    return reply.code(job.duplicate ? 200 : 202).send({ syncJobId: job.id, duplicate: job.duplicate });
  });
  app.get('/integrations/sync-jobs', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'integration:view', null);
    return { items: await many(db, `SELECT id, kind, status, stats, error, created_at, finished_at FROM sync_jobs ORDER BY created_at DESC LIMIT 100`) };
  }));

  // ── Audit log ─────────────────────────────────────────────────
  app.get('/audit', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'audit:view', null);
    const q = parse(z.object({ entityType: z.string().optional(), entityId: z.string().optional(), action: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return { items: await many(db,
      `SELECT id, actor_user_id, actor_type, action, entity_type, entity_id, before, after, source, host(ip) AS ip, request_id, created_at FROM audit_logs
        WHERE ($1::text IS NULL OR entity_type = $1) AND ($2::text IS NULL OR entity_id = $2) AND ($3::text IS NULL OR action = $3)
        ORDER BY id DESC LIMIT $4`, [q.entityType ?? null, q.entityId ?? null, q.action ?? null, q.limit]) };
  }));

  // ── Privacy: consent, export, deletion ─────────────────────────
  const PURPOSES = ['ai_processing', 'guardian_sharing', 'audio_recording', 'video_recording', 'external_sharing'] as const;
  app.get('/privacy/consents', async (req) => tx(req, async (db, auth) => {
    const sid = await myStudentId(db, auth).catch(() => null);
    return { items: await many(db, `SELECT DISTINCT ON (purpose) purpose, granted, policy_version, created_at FROM consents
                                      WHERE ($1::uuid IS NULL AND user_id = $2) OR subject_student_id = $1 ORDER BY purpose, created_at DESC`, [sid, auth.userId]) };
  }));
  app.post('/privacy/consents', async (req, reply) => tx(req, async (db, auth) => {
    const body = parse(z.object({ purpose: z.enum(PURPOSES), granted: z.boolean(), policyVersion: z.string().max(40), studentId: Uuid.optional() }), req.body);
    const sid = body.studentId ?? (await myStudentId(db, auth));
    if (body.studentId) await authorizeStudent(db, auth, 'consent:edit', body.studentId);
    await db.query(`INSERT INTO consents (user_id, subject_student_id, purpose, granted, policy_version) VALUES ($1,$2,$3,$4,$5)`,
      [auth.userId, sid, body.purpose, body.granted, body.policyVersion]);
    await audit(db, actor(req), { action: 'consent.change', entityType: 'student', entityId: sid, after: body });
    return created(reply, { ok: true });
  }));
  app.post('/privacy/data-requests', async (req, reply) => tx(req, async (db, auth) => {
    const body = parse(z.object({ kind: z.enum(['export', 'delete']), studentId: Uuid.optional() }), req.body);
    const sid = body.studentId ?? (await myStudentId(db, auth));
    if (body.studentId) await authorizeStudent(db, auth, 'student:view', body.studentId);
    const r = await one<{ id: string }>(db, `INSERT INTO data_requests (requester_id, subject_student_id, kind) VALUES ($1,$2,$3) RETURNING id`, [auth.userId, sid, body.kind]);
    await audit(db, actor(req), { action: `data_request.${body.kind}`, entityType: 'student', entityId: sid, after: { requestId: r!.id } });
    return created(reply, { id: r!.id, status: 'pending', note: 'Requests are reviewed by the institution before processing.' });
  }));
  app.post('/privacy/data-requests/:id/approve', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'consent:approve', null);
    const { id } = parse(IdParams, req.params);
    const r = await db.query(`UPDATE data_requests SET status = 'approved' WHERE id = $1 AND status = 'pending' RETURNING subject_student_id, kind`, [id]);
    if (!r.rowCount) throw notFound('Pending data request');
    await audit(db, actor(req), { action: 'data_request.approve', entityType: 'data_request', entityId: id, after: r.rows[0] });
    await emit(db, 'data_request.approved', 'data_request', id, { studentId: r.rows[0].subject_student_id, kind: r.rows[0].kind });
    return { ok: true };
  }));

  // ── Projects ─────────────────────────────────────────────────
  app.post('/projects', async (req, reply) => tx(req, async (db, auth) => {
    const body = parse(z.object({ title: z.string().min(3).max(200), problem: z.string().max(5000).optional(), description: z.string().max(20000).optional(),
      repoUrl: z.string().url().optional(), skillIds: z.array(Uuid).max(15).default([]), memberStudentIds: z.array(Uuid).max(10).default([]) }), req.body);
    const me = await myStudentId(db, auth);
    const p = await one<{ id: string }>(db, `INSERT INTO projects (title, problem, description, repo_url, skill_ids, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [body.title, body.problem ?? null, body.description ?? null, body.repoUrl ?? null, body.skillIds, auth.userId]);
    await db.query(`INSERT INTO project_members (project_id, student_id, role) VALUES ($1,$2,'owner')`, [p!.id, me]);
    for (const m of body.memberStudentIds.filter((x) => x !== me)) {
      if (await one(db, `SELECT 1 FROM students WHERE id = $1`, [m])) await db.query(`INSERT INTO project_members (project_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [p!.id, m]);
    }
    await db.query(`INSERT INTO evidence (student_id, source, activity_type, activity_ref_type, activity_ref_id, title, skill_ids, verification_level, confidence)
                    SELECT pm.student_id, 'project', 'project', 'project', $1, $2, $3, 'SELF_REPORTED', 0.25 FROM project_members pm WHERE pm.project_id = $1`,
      [p!.id, `Project: ${body.title}`, body.skillIds]);
    return created(reply, { id: p!.id });
  }));
  app.post('/projects/:id/evaluate', async (req) => tx(req, async (db, auth) => {
    requireAnywhere(auth, 'project:evaluate');
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ score: z.number().min(0).max(100), feedback: z.string().max(5000).optional(), outcome: z.string().max(2000).optional() }), req.body);
    const members = await many<{ student_id: string }>(db, `SELECT student_id FROM project_members WHERE project_id = $1`, [id]);
    if (!members.length) throw notFound('Project');
    for (const m of members) await authorizeStudent(db, auth, 'project:evaluate', m.student_id);
    const p = await one<{ skill_ids: string[] }>(db, `UPDATE projects SET status = 'evaluated', outcome = $2 WHERE id = $1 RETURNING skill_ids`, [id, body.outcome ?? null]);
    for (const m of members) {
      await db.query(`UPDATE evidence SET verification_level = 'VERIFIED', verified_by = $3, verified_at = now(), confidence = 0.9,
                        data = data || jsonb_build_object('score', $4::numeric, 'feedback', $5::text)
                      WHERE activity_ref_type = 'project' AND activity_ref_id = $1 AND student_id = $2`, [id, m.student_id, auth.userId, body.score, body.feedback ?? null]);
      for (const sk of p!.skill_ids) {
        await db.query(`INSERT INTO skill_signals (student_id, skill_id, source_type, source_id, performance, difficulty, verification, weight, occurred_at)
                        VALUES ($1,$2,'project',$3,$4,65,'VERIFIED',1.5, now())
                        ON CONFLICT (source_type, source_id, skill_id) DO UPDATE SET performance = EXCLUDED.performance`,
          [m.student_id, sk, id, body.score / 100]);
      }
      await emit(db, 'growth.recalculate', 'student', m.student_id, { studentId: m.student_id, reason: 'project' });
    }
    await audit(db, actor(req), { action: 'project.evaluate', entityType: 'project', entityId: id, after: body });
    return { ok: true };
  }));

  // ── Operational health ─────────────────────────────────────────
  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }));
  app.get('/ready', { config: { public: true } }, async () => {
    await withTenant({ tenantId: '00000000-0000-0000-0000-000000000000' }, (db) => db.query('SELECT 1'));
    return { status: 'ready' };
  });
  app.get('/admin/health', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'analytics:view', null);
    const queue = 'counts' in opts.bus ? await (opts.bus as any).counts().catch(() => null) : null;
    return {
      queue,
      outboxLagSeconds: (await one<any>(db, `SELECT extract(epoch FROM now() - min(created_at))::int AS lag FROM outbox_events WHERE published_at IS NULL`))?.lag ?? 0,
      ai: await one(db, `SELECT count(*)::int AS calls_1h, round(avg(latency_ms))::int AS avg_latency_ms, count(*) FILTER (WHERE status <> 'succeeded')::int AS failures_1h,
                              round(coalesce(sum(cost_usd),0)::numeric, 4) AS cost_1h FROM ai_interactions WHERE created_at > now() - interval '1 hour'`),
      failedSyncJobs24h: (await one<any>(db, `SELECT count(*)::int AS n FROM sync_jobs WHERE status = 'failed' AND created_at > now() - interval '1 day'`))?.n,
      securityEvents24h: await many(db, `SELECT action, count(*)::int AS n FROM audit_logs WHERE action IN ('auth.login_failed','auth.mfa_failed','auth.refresh_reuse_detected')
                                         AND created_at > now() - interval '1 day' GROUP BY action`),
      version: process.env.APP_VERSION ?? 'dev', env: config.NODE_ENV,
    };
  }));
}
