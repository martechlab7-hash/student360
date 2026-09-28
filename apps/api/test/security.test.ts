/** Tenant isolation and authorization. These tests must never be skipped. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, appPool, withTenant } from '../src/db/pool.js';
import { api, login, makeTenant, startApp, stopApp, type Fixture, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  ctx = await startApp();
  A = await makeTenant();
  B = await makeTenant();
});
afterAll(() => stopApp(ctx));

describe('database-level tenant isolation', () => {
  it('every table with tenant_id has RLS enabled AND forced', async () => {
    const r = await adminPool.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns col WHERE col.table_name = c.relname AND col.column_name = 'tenant_id')`);
    expect(r.rows.length).toBeGreaterThan(40);
    const unprotected = r.rows.filter((x) => !x.relrowsecurity || !x.relforcerowsecurity).map((x) => x.relname);
    expect(unprotected).toEqual([]);
  });

  it('runtime role cannot bypass RLS', async () => {
    const r = await appPool.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`);
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it('queries without a tenant context see nothing', async () => {
    const r = await appPool.query(`SELECT count(*)::int AS n FROM students`);
    expect(r.rows[0].n).toBe(0);
  });

  it('a tenant context sees only its own rows, even for unfiltered queries', async () => {
    const ids = await withTenant({ tenantId: A.tenantId }, async (db) => (await db.query(`SELECT id FROM students`)).rows.map((r) => r.id));
    expect(ids.sort()).toEqual(A.students.map((s) => s.id).sort());
    expect(ids).not.toContain(B.students[0]!.id);
  });

  it('cannot write rows into another tenant', async () => {
    await expect(withTenant({ tenantId: A.tenantId }, (db) =>
      db.query(`INSERT INTO org_units (tenant_id, type, name) VALUES ($1, 'campus', 'evil')`, [B.tenantId]))).rejects.toThrow(/row-level security/);
  });

  it('cannot update another tenant\'s rows (silently zero rows)', async () => {
    const r = await withTenant({ tenantId: A.tenantId }, (db) => db.query(`UPDATE students SET full_name = 'x' WHERE id = $1`, [B.students[0]!.id]));
    expect(r.rowCount).toBe(0);
  });

  it('audit log is append-only for the runtime role', async () => {
    await expect(withTenant({ tenantId: A.tenantId }, (db) => db.query(`DELETE FROM audit_logs`))).rejects.toThrow(/permission denied/);
    await expect(withTenant({ tenantId: A.tenantId }, (db) => db.query(`UPDATE audit_logs SET action = 'x'`))).rejects.toThrow(/permission denied/);
  });
});

describe('API-level isolation and RBAC', () => {
  it('rejects unauthenticated requests', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/v1/students' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('UNAUTHENTICATED');
  });

  it("tenant A's admin cannot read tenant B's student (404, no existence leak)", async () => {
    const t = await login(ctx.app, A.slug, `admin@${A.slug}.edu`);
    const r = await api(ctx.app, t).get(`/students/${B.students[0]!.id}`);
    expect(r.statusCode).toBe(404);
  });

  it("a token for tenant A cannot be used to log into tenant B's data by switching slug", async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { tenant: B.slug, email: `admin@${A.slug}.edu`, password: 'Test#Passw0rd-xyz' } });
    expect(r.statusCode).toBe(401);
  });

  it('teacher sees only students in their assigned section', async () => {
    const t = await login(ctx.app, A.slug, `teacher@${A.slug}.edu`);
    const list = await api(ctx.app, t).get('/students');
    const ids = list.json().items.map((s: any) => s.id);
    expect(ids).toContain(A.students[0]!.id);
    expect(ids).not.toContain(A.students[3]!.id); // section B
    expect((await api(ctx.app, t).get(`/students/${A.students[3]!.id}`)).statusCode).toBe(404);
  });

  it('student can view self but not a classmate', async () => {
    const t = await login(ctx.app, A.slug, `s0@${A.slug}.edu`);
    expect((await api(ctx.app, t).get(`/students/${A.students[0]!.id}`)).statusCode).toBe(200);
    expect((await api(ctx.app, t).get(`/students/${A.students[1]!.id}`)).statusCode).toBe(404);
  });

  it('student cannot perform staff actions', async () => {
    const t = await login(ctx.app, A.slug, `s0@${A.slug}.edu`);
    expect((await api(ctx.app, t).post('/roles', { key: 'hax', name: 'x', permissions: ['*:*'] })).statusCode).toBe(403);
    expect((await api(ctx.app, t).get('/audit')).statusCode).toBe(403);
  });

  it('parent sees only their linked child', async () => {
    const t = await login(ctx.app, A.slug, `parent@${A.slug}.edu`);
    expect((await api(ctx.app, t).get(`/parent/children/${A.students[0]!.id}/summary`)).statusCode).toBe(200);
    expect((await api(ctx.app, t).get(`/parent/children/${A.students[1]!.id}/summary`)).statusCode).toBe(404);
  });

  it('role changes are validated and audited', async () => {
    const t = await login(ctx.app, A.slug, `admin@${A.slug}.edu`);
    const bad = await api(ctx.app, t).post('/roles', { key: 'x_role', name: 'X', permissions: ['student:fly'] });
    expect(bad.statusCode).toBe(400);
    const ok = await api(ctx.app, t).post('/roles', { key: 'lab_helper', name: 'Lab helper', permissions: ['content:view', 'task:view'] });
    expect(ok.statusCode).toBe(201);
    const audit = await api(ctx.app, t).get('/audit?action=role.create');
    expect(audit.json().items.some((a: any) => a.entity_id === ok.json().id)).toBe(true);
  });

  it('platform provisioning requires the operator token', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/platform/tenants', payload: { slug: 'nope', name: 'No', admin: { email: 'a@b.co', fullName: 'A', password: 'Xy#1234567890' } } });
    expect(r.statusCode).toBe(403);
  });
});
