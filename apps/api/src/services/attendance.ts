/**
 * Event attendance. Check-in requires: authenticated student + short-lived session-bound token +
 * time window + registration. Anomalies are recorded as flags and routed to the organiser for
 * review — the student is never automatically accused or penalised.
 */
import { detectAnomalies, issueAttendanceToken, verifyAttendanceToken } from '@s360/core';
import type { AuthContext } from '../auth/principal.js';
import { many, one, type Db } from '../db/pool.js';
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { audit, type AuditActor } from '../lib/audit.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { emit } from '../lib/outbox.js';

export function newSessionSecret() {
  return encrypt(randomToken(32));
}

export async function currentToken(db: Db, sessionId: string) {
  const s = await one<{ attendance_secret: string; starts_at: Date; ends_at: Date; grace_minutes: number }>(
    db, `SELECT attendance_secret, starts_at, ends_at, grace_minutes FROM event_sessions WHERE id = $1`, [sessionId]);
  if (!s) throw notFound('Session');
  const now = Date.now();
  const grace = s.grace_minutes * 60_000;
  if (now < new Date(s.starts_at).getTime() - grace || now > new Date(s.ends_at).getTime() + grace) {
    throw new AppError(409, 'SESSION_NOT_ACTIVE', 'Attendance tokens are only issued while the session is running');
  }
  return issueAttendanceToken(decrypt(s.attendance_secret), sessionId, now);
}

export async function checkIn(db: Db, auth: AuthContext, input: { sessionId: string; token: string; deviceId?: string }, ip: string | null) {
  const student = await one<{ id: string }>(db, `SELECT id FROM students WHERE user_id = $1`, [auth.userId]);
  if (!student) throw notFound('Student profile');
  const s = await one<any>(db,
    `SELECT es.*, e.id AS event_id, e.name, e.registration_required, e.dimension_id, e.skill_ids, e.status AS event_status
       FROM event_sessions es JOIN events e ON e.id = es.event_id WHERE es.id = $1`, [input.sessionId]);
  if (!s || s.event_status !== 'published') throw notFound('Session');

  const v = verifyAttendanceToken(decrypt(s.attendance_secret), s.id, input.token);
  if (!v.valid) throw new AppError(400, 'INVALID_ATTENDANCE_TOKEN', v.reason === 'expired' ? 'This QR code has expired — scan the current one' : 'Invalid attendance code');

  // Serialise check-ins per session so device/duplicate checks see a consistent view.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`attendance:${s.id}`]);
  const registered = !!(await one(db, `SELECT 1 FROM event_registrations WHERE event_id = $1 AND student_id = $2 AND status = 'registered'`, [s.event_id, student.id]));
  const prior = await many<{ student_id: string; device_hash: string | null; ip: string | null; check_in_at: Date }>(
    db, `SELECT student_id, device_hash, host(ip) AS ip, check_in_at FROM event_attendance WHERE session_id = $1`, [s.id]);
  const overlapping = await many<{ session_id: string; check_in_at: Date }>(db,
    `SELECT ea.session_id, ea.check_in_at FROM event_attendance ea JOIN event_sessions os ON os.id = ea.session_id
      WHERE ea.student_id = $1 AND ea.session_id <> $2 AND os.starts_at < $4 AND os.ends_at > $3`,
    [student.id, s.id, s.starts_at, s.ends_at]);
  // Device identifiers are hashed per tenant; raw device ids are never stored.
  const deviceHash = input.deviceId ? sha256(`${auth.tenantId}:${input.deviceId}`) : null;
  const now = new Date();
  const result = detectAnomalies(
    { studentId: student.id, deviceHash, ip, at: now },
    { registered: registered || !s.registration_required, sessionStart: new Date(s.starts_at), sessionEnd: new Date(s.ends_at), graceMinutes: s.grace_minutes,
      priorCheckIns: prior.map((p) => ({ studentId: p.student_id, deviceHash: p.device_hash, ip: p.ip, at: new Date(p.check_in_at) })),
      overlappingSessionCheckIns: overlapping.map((o) => ({ sessionId: o.session_id, at: new Date(o.check_in_at) })) });
  if (result.duplicate) throw conflict('You are already checked in to this session');

  const status = result.flags.length ? 'flagged' : 'accepted';
  const att = await one<{ id: string }>(db,
    `INSERT INTO event_attendance (session_id, student_id, method, device_hash, ip, token_window, status, flags)
     VALUES ($1,$2,'dynamic_qr',$3,$4,$5,$6,$7) RETURNING id`,
    [s.id, student.id, deviceHash, ip, v.window, status, result.flags]);

  await db.query(
    `INSERT INTO evidence (student_id, source, activity_type, activity_ref_type, activity_ref_id, title, data, dimension_id, skill_ids, verification_level, confidence, verified_at)
     VALUES ($1,'qr','event_participation','event_attendance',$2,$3,$4,$5,$6,$7,$8, CASE WHEN $7 = 'VERIFIED' THEN now() END)`,
    [student.id, att!.id, `Attended: ${s.name}`, JSON.stringify({ eventId: s.event_id, sessionId: s.id, flags: result.flags }),
      s.dimension_id, s.skill_ids, status === 'accepted' ? 'VERIFIED' : 'PARTIALLY_VERIFIED', status === 'accepted' ? 0.9 : 0.4]);

  if (status === 'flagged') await emit(db, 'attendance.flagged', 'event_attendance', att!.id, { eventId: s.event_id, flags: result.flags });
  await emit(db, 'attendance.recorded', 'event_attendance', att!.id, { studentId: student.id });
  return { attendanceId: att!.id, status, message: status === 'accepted' ? 'Checked in' : 'Checked in — pending organiser confirmation' };
}

export async function reviewAttendance(db: Db, actor: AuditActor, attendanceId: string, decision: 'accepted' | 'rejected', note?: string) {
  const a = await one<any>(db, `SELECT * FROM event_attendance WHERE id = $1 FOR UPDATE`, [attendanceId]);
  if (!a) throw notFound('Attendance');
  await db.query(`UPDATE event_attendance SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
    [attendanceId, decision, actor.userId, note ?? null]);
  const level = decision === 'accepted' ? 'VERIFIED' : 'SELF_REPORTED';
  const ev = await one<{ id: string; verification_level: string }>(db,
    `SELECT id, verification_level FROM evidence WHERE activity_ref_type = 'event_attendance' AND activity_ref_id = $1`, [attendanceId]);
  if (ev && ev.verification_level !== level) {
    await db.query(`UPDATE evidence SET verification_level = $2, verified_by = $3, verified_at = now(), confidence = $4 WHERE id = $1`,
      [ev.id, level, actor.userId, decision === 'accepted' ? 0.9 : 0.1]);
    await db.query(`INSERT INTO evidence_verifications (evidence_id, from_level, to_level, actor_id, note) VALUES ($1,$2,$3,$4,$5)`,
      [ev.id, ev.verification_level, level, actor.userId, note ?? `attendance ${decision}`]);
  }
  await audit(db, actor, { action: 'attendance.review', entityType: 'event_attendance', entityId: attendanceId,
    before: { status: a.status, flags: a.flags }, after: { status: decision, note } });
  await emit(db, 'evidence.verified', 'student', a.student_id, { studentId: a.student_id });
}
