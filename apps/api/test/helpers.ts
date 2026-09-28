import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { closePools, one, withTenant } from '../src/db/pool.js';
import { buildApp } from '../src/http/app.js';
import { InlineBus } from '../src/jobs/bus.js';
import { handlers } from '../src/jobs/handlers.js';
import { relayOutbox } from '../src/jobs/relay.js';
import { createStaff, createStudent, linkGuardian } from '../src/services/people.js';
import { provisionTenant } from '../src/services/tenancy.js';

export const PASSWORD = 'Test#Passw0rd-xyz';

export interface TestCtx { app: FastifyInstance; bus: InlineBus }

export async function startApp(): Promise<TestCtx> {
  const bus = new InlineBus(() => handlers);
  const app = await buildApp({ bus, logger: false });
  await app.ready();
  return { app, bus };
}

export async function stopApp(ctx: TestCtx) {
  await ctx.app.close();
  await closePools();
}

/** Relay the outbox and run jobs until quiescent. */
export async function drain(bus: InlineBus) {
  for (let i = 0; i < 50; i++) {
    const n = await relayOutbox(bus);
    const m = await bus.drain();
    if (n === 0 && m === 0) break;
  }
  if (bus.failures.length) {
    const f = bus.failures.splice(0);
    throw new Error(`background jobs failed: ${f.map((x) => `${x.name}: ${(x.error as Error).stack}`).join('\n')}`);
  }
}

export interface Fixture {
  slug: string; tenantId: string; adminId: string;
  org: { campus: string; dept: string; program: string; batch: string; secA: string; secB: string };
  skills: { speaking: string; aptitude: string };
  teacherId: string; students: { id: string; userId: string | null; email: string | null }[]; parentId: string;
}

/** A complete, isolated tenant: org tree, skills, a teacher on section A, students in A and B, a parent. */
export async function makeTenant(): Promise<Fixture> {
  const slug = `t-${randomBytes(4).toString('hex')}`;
  const { tenantId, adminUserId } = await provisionTenant({ slug, name: `Test ${slug}`, admin: { email: `admin@${slug}.edu`, fullName: 'Admin', password: PASSWORD } });
  return withTenant({ tenantId, userId: adminUserId }, async (db) => {
    const ins = async (type: string, name: string, parent: string | null) =>
      (await one<{ id: string }>(db, `INSERT INTO org_units (type, name, code, parent_id) VALUES ($1,$2,$3,$4) RETURNING id`, [type, name, `${name}-${type}`, parent]))!.id;
    const campus = await ins('campus', 'C', null);
    const dept = await ins('department', 'D', campus);
    const program = await ins('program', 'P', dept);
    const batch = await ins('batch', 'B', program);
    const secA = await ins('section', 'A', batch);
    const secB = await ins('section', 'Bsec', batch);
    const dim = async (k: string) => (await one<{ id: string }>(db, `SELECT id FROM growth_dimensions WHERE key = $1`, [k]))!.id;
    const speaking = (await one<{ id: string }>(db, `INSERT INTO skills (key, name, dimension_id) VALUES ('speaking','Speaking',$1) RETURNING id`, [await dim('communication')]))!.id;
    const aptitude = (await one<{ id: string }>(db, `INSERT INTO skills (key, name, dimension_id) VALUES ('aptitude','Aptitude',$1) RETURNING id`, [await dim('problem_solving')]))!.id;
    const actor = { userId: adminUserId };
    const teacherId = (await createStaff(db, actor, { email: `teacher@${slug}.edu`, fullName: 'Teacher', password: PASSWORD,
      roles: [{ role: 'teacher', scopeType: 'section', scopeId: secA }] }, tenantId)).userId;
    const students: Fixture['students'] = [];
    for (let i = 0; i < 4; i++) {
      const email = i < 3 ? `s${i}@${slug}.edu` : null;
      const s = await createStudent(db, actor, { fullName: `Student ${i}`, sectionId: i < 3 ? secA : secB, rollNo: `R${i}`, email, password: email ? PASSWORD : undefined, interests: ['music'] });
      students.push({ id: s.id, userId: s.userId, email });
    }
    // Student in section B with a login, for cross-section checks.
    const sb = await createStudent(db, actor, { fullName: 'Student B', sectionId: secB, rollNo: 'RB', email: `sb@${slug}.edu`, password: PASSWORD });
    students.push({ id: sb.id, userId: sb.userId, email: `sb@${slug}.edu` });
    const parentId = (await linkGuardian(db, actor, students[0]!.id, { email: `parent@${slug}.edu`, fullName: 'Parent', password: PASSWORD })).guardianUserId;
    return { slug, tenantId, adminId: adminUserId, org: { campus, dept, program, batch, secA, secB }, skills: { speaking, aptitude }, teacherId, students, parentId };
  });
}

export async function login(app: FastifyInstance, tenant: string, email: string, password = PASSWORD): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { tenant, email, password } });
  if (r.statusCode !== 200) throw new Error(`login failed for ${email}: ${r.statusCode} ${r.body}`);
  return r.json().accessToken;
}

export function api(app: FastifyInstance, token: string) {
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/api/v1${url}`, payload: payload as any, headers: { authorization: `Bearer ${token}`, ...headers } });
  return {
    get: (u: string) => call('GET', u),
    post: (u: string, p?: unknown, h?: Record<string, string>) => call('POST', u, p ?? {}, h),
    put: (u: string, p?: unknown) => call('PUT', u, p),
    patch: (u: string, p?: unknown) => call('PATCH', u, p),
    del: (u: string) => call('DELETE', u),
  };
}
