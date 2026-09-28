import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { actor, created, hasAnywhere, IdParams, parse, requireAnywhere, tx, Uuid, perMinute } from '../http/context.js';
import { myStudentId } from '../http/scope.js';
import { checkIn, currentToken, newSessionSecret, reviewAttendance } from '../services/attendance.js';

export async function eventRoutes(app: FastifyInstance) {
  app.post('/events', async (req, reply) => tx(req, async (db, auth) => {
    requireAnywhere(auth, 'event:create');
    const body = parse(z.object({
      name: z.string().min(2).max(200), organizer: z.string().min(1).max(200), description: z.string().max(5000).optional(), venue: z.string().max(200).optional(),
      category: z.enum(['academic', 'technical', 'cultural', 'sports', 'social', 'career', 'leadership', 'research']).default('academic'),
      capacity: z.number().int().positive().optional(), dimensionKey: z.string().optional(), skillIds: z.array(Uuid).default([]),
      registrationRequired: z.boolean().default(true), certificate: z.boolean().default(false),
      eligibility: z.object({ orgUnitIds: z.array(Uuid).default([]) }).default({ orgUnitIds: [] }),
    }), req.body);
    const dim = body.dimensionKey ? await one<{ id: string }>(db, `SELECT id FROM growth_dimensions WHERE key = $1`, [body.dimensionKey]) : null;
    const e = await one<{ id: string }>(db,
      `INSERT INTO events (name, organizer, description, venue, category, capacity, dimension_id, skill_ids, registration_required, certificate, eligibility, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [body.name, body.organizer, body.description ?? null, body.venue ?? null, body.category, body.capacity ?? null, dim?.id ?? null, body.skillIds,
        body.registrationRequired, body.certificate, JSON.stringify(body.eligibility), auth.userId]);
    await audit(db, actor(req), { action: 'event.create', entityType: 'event', entityId: e!.id, after: body });
    return created(reply, { id: e!.id });
  }));

  app.post('/events/:id/sessions', async (req, reply) => tx(req, async (db, auth) => {
    requireAnywhere(auth, 'event:edit');
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ title: z.string().max(200).optional(), startsAt: z.coerce.date(), endsAt: z.coerce.date(),
      graceMinutes: z.number().int().min(0).max(120).default(15), checkOutRequired: z.boolean().default(false) }), req.body);
    if (body.endsAt <= body.startsAt) throw badRequest('endsAt must be after startsAt');
    if (!(await one(db, `SELECT 1 FROM events WHERE id = $1`, [id]))) throw notFound('Event');
    const s = await one<{ id: string }>(db,
      `INSERT INTO event_sessions (event_id, title, starts_at, ends_at, grace_minutes, attendance_secret, check_out_required) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [id, body.title ?? null, body.startsAt, body.endsAt, body.graceMinutes, newSessionSecret(), body.checkOutRequired]);
    return created(reply, { id: s!.id });
  }));

  app.post('/events/:id/publish', async (req) => tx(req, async (db, auth) => {
    requireAnywhere(auth, 'event:publish');
    const { id } = parse(IdParams, req.params);
    const r = await db.query(`UPDATE events SET status = 'published' WHERE id = $1 AND status = 'draft' RETURNING id`, [id]);
    if (!r.rowCount) throw conflict('Event is not a draft');
    await audit(db, actor(req), { action: 'event.publish', entityType: 'event', entityId: id });
    return { ok: true };
  }));

  app.get('/events', async (req) => tx(req, async (db, auth) => {
    const staff = hasAnywhere(auth, 'event:edit');
    const studentId = staff ? null : await one<{ id: string }>(db, `SELECT id FROM students WHERE user_id = $1`, [auth.userId]).then((r) => r?.id ?? null);
    return { items: await many(db,
      `SELECT e.id, e.name, e.organizer, e.category, e.venue, e.capacity, e.status, e.certificate,
              (SELECT min(starts_at) FROM event_sessions es WHERE es.event_id = e.id) AS starts_at,
              (SELECT count(*)::int FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'registered') AS registered,
              ($2::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM event_registrations r WHERE r.event_id = e.id AND r.student_id = $2 AND r.status = 'registered')) AS is_registered,
              (SELECT json_agg(json_build_object('id', es.id, 'title', es.title, 'startsAt', es.starts_at, 'endsAt', es.ends_at) ORDER BY es.starts_at)
                 FROM event_sessions es WHERE es.event_id = e.id) AS sessions
         FROM events e WHERE ($1 OR e.status = 'published') ORDER BY starts_at NULLS LAST LIMIT 100`, [staff, studentId]) };
  }));

  app.post('/events/:id/register', async (req, reply) => tx(req, async (db, auth) => {
    const { id } = parse(IdParams, req.params);
    const studentId = await myStudentId(db, auth);
    const e = await one<any>(db, `SELECT id, capacity, status, eligibility FROM events WHERE id = $1 FOR UPDATE`, [id]);
    if (!e || e.status !== 'published') throw notFound('Event');
    const units: string[] = e.eligibility?.orgUnitIds ?? [];
    if (units.length && !(await one(db, `SELECT 1 FROM students s JOIN org_units sec ON sec.id = s.section_id WHERE s.id = $1 AND sec.path && $2::uuid[]`, [studentId, units]))) {
      throw conflict('You are not eligible for this event');
    }
    const count = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM event_registrations WHERE event_id = $1 AND status = 'registered'`, [id]);
    const status = e.capacity && count!.n >= e.capacity ? 'waitlisted' : 'registered';
    const r = await db.query(`INSERT INTO event_registrations (event_id, student_id, status) VALUES ($1,$2,$3)
                              ON CONFLICT (event_id, student_id) DO UPDATE SET status = CASE WHEN event_registrations.status = 'cancelled' THEN EXCLUDED.status ELSE event_registrations.status END
                              RETURNING status`, [id, studentId, status]);
    return created(reply, { status: r.rows[0].status });
  }));

  /** Organiser screen polls this to render a rotating QR code (valid ~20 s). */
  app.get('/events/sessions/:id/token', async (req) => tx(req, async (db, auth) => {
    requireAnywhere(auth, 'attendance:create');
    if (auth.kind !== 'staff') throw notFound('Session');
    const { id } = parse(IdParams, req.params);
    return currentToken(db, id);
  }));

  app.post('/attendance/check-in', { config: { rateLimit: perMinute(10) } }, async (req, reply) => tx(req, async (db, auth) => {
    const body = parse(z.object({ sessionId: Uuid, token: z.string().min(5).max(100), deviceId: z.string().max(200).optional() }), req.body);
    return created(reply, await checkIn(db, auth, body, req.ip));
  }));

  app.get('/attendance/flagged', async (req) => tx(req, async (db, auth) => {
    requireAnywhere(auth, 'attendance:approve');
    return { items: await many(db,
      `SELECT a.id, a.student_id, s.full_name, a.flags, a.check_in_at, e.name AS event, es.starts_at FROM event_attendance a
         JOIN students s ON s.id = a.student_id JOIN event_sessions es ON es.id = a.session_id JOIN events e ON e.id = es.event_id
        WHERE a.status = 'flagged' ORDER BY a.check_in_at DESC LIMIT 200`) };
  }));

  app.post('/attendance/:id/review', async (req) => tx(req, async (db, auth) => {
    requireAnywhere(auth, 'attendance:approve');
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ decision: z.enum(['accepted', 'rejected']), note: z.string().max(1000).optional() }), req.body);
    await reviewAttendance(db, actor(req), id, body.decision, body.note);
    return { ok: true };
  }));
}
