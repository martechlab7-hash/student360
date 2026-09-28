import { hashPassword, passwordPolicyErrors } from '../auth/passwords.js';
import { one, type Db } from '../db/pool.js';
import { audit, type AuditActor } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import { roleId } from './tenancy.js';

export interface NewStudent {
  fullName: string;
  email?: string | null;
  sectionId: string;
  rollNo?: string | null;
  enrollmentYear?: number | null;
  interests?: string[];
  careerGoals?: string[];
  profile?: Record<string, unknown>;
  password?: string;
}

async function assertSection(db: Db, sectionId: string) {
  const s = await one<{ type: string }>(db, `SELECT type FROM org_units WHERE id = $1`, [sectionId]);
  if (!s) throw notFound('Section');
  if (s.type !== 'section') throw badRequest('Students must be placed in a section');
}

async function createLoginUser(db: Db, email: string, fullName: string, kind: string, password?: string) {
  if (password) {
    const errs = passwordPolicyErrors(password, email);
    if (errs.length) throw badRequest('Password does not meet policy', errs);
  }
  const existing = await one(db, `SELECT 1 FROM users WHERE email = $1`, [email]);
  if (existing) throw conflict('A user with this email already exists');
  const hash = password ? await hashPassword(password) : null;
  const u = await one<{ id: string }>(
    db,
    `INSERT INTO users (email, full_name, password_hash, kind, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [email, fullName, hash, kind, password ? 'active' : 'invited'],
  );
  return u!.id;
}

export async function createStudent(db: Db, actor: AuditActor, input: NewStudent): Promise<{ id: string; userId: string | null }> {
  await assertSection(db, input.sectionId);
  const userId = input.email ? await createLoginUser(db, input.email, input.fullName, 'student', input.password) : null;
  const s = await one<{ id: string }>(
    db,
    `INSERT INTO students (user_id, section_id, roll_no, full_name, enrollment_year, interests, career_goals, profile)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [userId, input.sectionId, input.rollNo ?? null, input.fullName, input.enrollmentYear ?? null,
      input.interests ?? [], input.careerGoals ?? [], JSON.stringify(input.profile ?? {})],
  );
  if (userId) {
    await db.query(`INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, created_by) VALUES ($1,$2,'student',$3,$4)`,
      [userId, await roleId(db, 'student'), s!.id, actor.userId ?? null]);
  }
  await audit(db, actor, { action: 'student.create', entityType: 'student', entityId: s!.id, after: { ...input, password: undefined } });
  return { id: s!.id, userId };
}

export async function linkGuardian(db: Db, actor: AuditActor, studentId: string, g: { email: string; fullName: string; relationship?: string; password?: string }) {
  const st = await one(db, `SELECT id FROM students WHERE id = $1`, [studentId]);
  if (!st) throw notFound('Student');
  let user = await one<{ id: string; kind: string }>(db, `SELECT id, kind FROM users WHERE email = $1`, [g.email]);
  if (user && user.kind !== 'guardian') throw conflict('Email belongs to a non-guardian account');
  const userId = user?.id ?? (await createLoginUser(db, g.email, g.fullName, 'guardian', g.password));
  await db.query(`INSERT INTO guardian_links (guardian_user_id, student_id, relationship) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [userId, studentId, g.relationship ?? 'parent']);
  await db.query(`INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, created_by) VALUES ($1,$2,'student',$3,$4) ON CONFLICT DO NOTHING`,
    [userId, await roleId(db, 'parent'), studentId, actor.userId ?? null]);
  await audit(db, actor, { action: 'guardian.link', entityType: 'student', entityId: studentId, after: { guardianUserId: userId, relationship: g.relationship } });
  return { guardianUserId: userId };
}

export async function createStaff(db: Db, actor: AuditActor, input: { email: string; fullName: string; password?: string; roles: { role: string; scopeType: string; scopeId?: string }[] }, tenantId: string) {
  const userId = await createLoginUser(db, input.email, input.fullName, 'staff', input.password);
  for (const r of input.roles) {
    await db.query(`INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [userId, await roleId(db, r.role), r.scopeType, r.scopeType === 'tenant' ? tenantId : r.scopeId, actor.userId ?? null]);
  }
  await audit(db, actor, { action: 'user.create', entityType: 'user', entityId: userId, after: { email: input.email, roles: input.roles } });
  return { userId, inviteToken: input.password ? null : randomToken(24) };
}

export interface ImportRecord {
  externalId: string;
  fullName: string;
  email?: string | null;
  sectionCode: string;
  rollNo?: string | null;
  enrollmentYear?: number | null;
}

/**
 * Idempotent student import from an external system (ERP/SIS/CSV). The (system, externalId)
 * pair maps to exactly one student, so retries and repeated syncs update instead of duplicating.
 */
export async function upsertImportedStudent(db: Db, actor: AuditActor, system: string, rec: ImportRecord): Promise<'created' | 'updated' | 'unchanged'> {
  const section = await one<{ id: string }>(db, `SELECT id FROM org_units WHERE type = 'section' AND code = $1`, [rec.sectionCode]);
  if (!section) throw badRequest(`Unknown section code ${rec.sectionCode}`);
  // Lock the identity key so concurrent retries serialise.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ext:${system}:student:${rec.externalId}`]);
  const link = await one<{ entity_id: string }>(
    db, `SELECT entity_id FROM external_identities WHERE system = $1 AND entity_type = 'student' AND external_id = $2`, [system, rec.externalId]);
  if (link) {
    const r = await db.query(
      `UPDATE students SET full_name = $2, section_id = $3, roll_no = COALESCE($4, roll_no), enrollment_year = COALESCE($5, enrollment_year)
        WHERE id = $1 AND (full_name, section_id, roll_no, enrollment_year) IS DISTINCT FROM ($2, $3, COALESCE($4, roll_no), COALESCE($5, enrollment_year))`,
      [link.entity_id, rec.fullName, section.id, rec.rollNo ?? null, rec.enrollmentYear ?? null]);
    await db.query(`UPDATE external_identities SET synced_at = now() WHERE system = $1 AND entity_type = 'student' AND external_id = $2`, [system, rec.externalId]);
    return r.rowCount ? 'updated' : 'unchanged';
  }
  // Match an existing student by roll number before creating (prevents duplicates from manual entry).
  const byRoll = rec.rollNo ? await one<{ id: string }>(db, `SELECT id FROM students WHERE roll_no = $1`, [rec.rollNo]) : null;
  const studentId = byRoll?.id ?? (await createStudent(db, { ...actor, actorType: 'integration' }, {
    fullName: rec.fullName, email: rec.email, sectionId: section.id, rollNo: rec.rollNo, enrollmentYear: rec.enrollmentYear,
  })).id;
  await db.query(`INSERT INTO external_identities (system, entity_type, external_id, entity_id) VALUES ($1,'student',$2,$3)`,
    [system, rec.externalId, studentId]);
  return byRoll ? 'updated' : 'created';
}
