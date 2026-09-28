/** Organisation hierarchy, RBAC administration and tenant configuration. */
import type { FastifyInstance } from 'fastify';
import { can, DEFAULT_SCORING_CONFIG, isValidPermissionKey, scopesFor, validateScoringConfig } from '@s360/core';
import { z } from 'zod';
import { orgUnitTarget } from '../auth/principal.js';
import { many, one } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { actor, authorize, created, IdParams, parse, tx, Uuid } from '../http/context.js';
import { createStaff } from '../services/people.js';

const PARENT_TYPE: Record<string, string | null> = { campus: null, department: 'campus', program: 'department', batch: 'program', section: 'batch' };

export async function adminRoutes(app: FastifyInstance) {
  // ── Org hierarchy ────────────────────────────────────────────────
  app.get('/org/units', async (req) => tx(req, async (db, auth) => {
    if (can(auth.principal, 'org_unit:view')) {
      return { items: await many(db, `SELECT id, parent_id, type, name, code FROM org_units ORDER BY array_length(path,1), name`) };
    }
    // Scoped staff see their own subtrees (plus ancestors for context).
    const unitIds = scopesFor(auth.principal, 'org_unit:view').map((s) => s.id);
    return { items: await many(db,
      `SELECT DISTINCT u.id, u.parent_id, u.type, u.name, u.code, array_length(u.path,1) AS depth FROM org_units u
        WHERE u.path && $1::uuid[] OR u.id IN (SELECT unnest(path) FROM org_units WHERE id = ANY($1::uuid[]))
        ORDER BY depth, u.name`, [unitIds]) };
  }));

  app.post('/org/units', async (req, reply) => tx(req, async (db, auth) => {
    const body = parse(z.object({ type: z.enum(['campus', 'department', 'program', 'batch', 'section']), name: z.string().min(1).max(200),
      code: z.string().max(50).optional(), parentId: Uuid.optional() }), req.body);
    const expectedParent = PARENT_TYPE[body.type];
    if (expectedParent) {
      if (!body.parentId) throw badRequest(`A ${body.type} needs a parent ${expectedParent}`);
      const p = await one<{ type: string }>(db, `SELECT type FROM org_units WHERE id = $1`, [body.parentId]);
      if (!p) throw notFound('Parent unit');
      if (p.type !== expectedParent) throw badRequest(`Parent of a ${body.type} must be a ${expectedParent}`);
      authorize(auth, 'org_unit:create', await orgUnitTarget(db, auth.tenantId, body.parentId));
    } else {
      authorize(auth, 'org_unit:create', null);
    }
    const u = await one<{ id: string }>(db, `INSERT INTO org_units (type, name, code, parent_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [body.type, body.name, body.code ?? null, body.parentId ?? null]);
    await audit(db, actor(req), { action: 'org_unit.create', entityType: 'org_unit', entityId: u!.id, after: body });
    return created(reply, { id: u!.id });
  }));

  // ── Roles & permissions (data-driven, tenant-editable) ─────────────
  app.get('/roles', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'role:view', null);
    return { items: await many(db, `SELECT r.id, r.key, r.name, r.is_system, coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
                                       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.name`) };
  }));

  const RoleBody = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), name: z.string().min(1).max(100), permissions: z.array(z.string()).max(500) });
  const checkPerms = (perms: string[]) => {
    const bad = perms.filter((p) => p !== '*:*' && !isValidPermissionKey(p));
    if (bad.length) throw badRequest('Unknown permissions', bad);
  };

  app.post('/roles', async (req, reply) => tx(req, async (db, auth) => {
    authorize(auth, 'role:create', null);
    const body = parse(RoleBody, req.body);
    checkPerms(body.permissions);
    if (await one(db, `SELECT 1 FROM roles WHERE key = $1`, [body.key])) throw conflict('Role key already exists');
    const r = await one<{ id: string }>(db, `INSERT INTO roles (key, name) VALUES ($1,$2) RETURNING id`, [body.key, body.name]);
    await db.query(`INSERT INTO role_permissions (role_id, permission_key) SELECT $1, unnest($2::text[])`, [r!.id, body.permissions]);
    await audit(db, actor(req), { action: 'role.create', entityType: 'role', entityId: r!.id, after: body });
    return created(reply, { id: r!.id });
  }));

  app.put('/roles/:id/permissions', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'role:edit', null);
    const { id } = parse(IdParams, req.params);
    const { permissions } = parse(z.object({ permissions: z.array(z.string()).max(500) }), req.body);
    checkPerms(permissions);
    const before = await many<{ permission_key: string }>(db, `SELECT permission_key FROM role_permissions WHERE role_id = $1`, [id]);
    if (!(await one(db, `SELECT 1 FROM roles WHERE id = $1`, [id]))) throw notFound('Role');
    await db.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
    await db.query(`INSERT INTO role_permissions (role_id, permission_key) SELECT $1, unnest($2::text[])`, [id, permissions]);
    await audit(db, actor(req), { action: 'role.permissions_change', entityType: 'role', entityId: id, before: before.map((b) => b.permission_key), after: permissions });
    return { ok: true };
  }));

  const Assignment = z.object({ role: z.string(), scopeType: z.enum(['tenant', 'campus', 'department', 'program', 'batch', 'section', 'student']), scopeId: Uuid.optional() });

  app.post('/users', async (req, reply) => tx(req, async (db, auth) => {
    authorize(auth, 'user:create', null);
    const body = parse(z.object({ email: z.string().email(), fullName: z.string().min(1), password: z.string().optional(), roles: z.array(Assignment).min(1) }), req.body);
    if (body.roles.some((r) => r.scopeType !== 'tenant' && !r.scopeId)) throw badRequest('scopeId is required for non-tenant scopes');
    return created(reply, await createStaff(db, actor(req), body, auth.tenantId));
  }));

  app.post('/users/:id/roles', async (req, reply) => tx(req, async (db, auth) => {
    authorize(auth, 'role:edit', null);
    const { id } = parse(IdParams, req.params);
    const a = parse(Assignment, req.body);
    const role = await one<{ id: string }>(db, `SELECT id FROM roles WHERE key = $1`, [a.role]);
    if (!role) throw notFound('Role');
    const scopeId = a.scopeType === 'tenant' ? auth.tenantId : a.scopeId;
    if (!scopeId) throw badRequest('scopeId required');
    const r = await one<{ id: string }>(db, `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, created_by) VALUES ($1,$2,$3,$4,$5)
                                            ON CONFLICT DO NOTHING RETURNING id`, [id, role.id, a.scopeType, scopeId, auth.userId]);
    await audit(db, actor(req), { action: 'role.assign', entityType: 'user', entityId: id, after: { ...a, scopeId } });
    return created(reply, { id: r?.id ?? null });
  }));

  app.delete('/role-assignments/:id', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'role:edit', null);
    const { id } = parse(IdParams, req.params);
    const before = await one(db, `DELETE FROM role_assignments WHERE id = $1 RETURNING user_id, role_id, scope_type, scope_id`, [id]);
    if (!before) throw notFound('Role assignment');
    await audit(db, actor(req), { action: 'role.revoke', entityType: 'role_assignment', entityId: id, before });
    return { ok: true };
  }));

  // ── Development dimensions & scoring (configurable, versioned) ─────
  app.get('/config/dimensions', async (req) => tx(req, async (db, auth) => {
    if (!can(auth.principal, 'dimension:configure')) {
      return { items: await many(db, `SELECT id, key, name, enabled FROM growth_dimensions WHERE enabled AND NOT sensitive ORDER BY sort`) };
    }
    return { items: await many(db, `SELECT id, key, name, weight, enabled, sensitive, sort FROM growth_dimensions ORDER BY sort`) };
  }));

  app.put('/config/dimensions', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'dimension:configure', null);
    const body = parse(z.object({ dimensions: z.array(z.object({ key: z.string().regex(/^[a-z_]{2,40}$/), name: z.string().min(1), weight: z.number().min(0).max(100),
      enabled: z.boolean(), sensitive: z.boolean().default(false) })).min(1) }), req.body);
    const before = await many(db, `SELECT key, name, weight, enabled, sensitive FROM growth_dimensions ORDER BY sort`);
    const cfg = { ...DEFAULT_SCORING_CONFIG, dimensions: body.dimensions };
    const errs = validateScoringConfig(cfg);
    if (errs.length) throw badRequest('Invalid dimension configuration', errs);
    let sort = 0;
    for (const d of body.dimensions) {
      await db.query(`INSERT INTO growth_dimensions (key, name, weight, enabled, sensitive, sort) VALUES ($1,$2,$3,$4,$5,$6)
                      ON CONFLICT (tenant_id, key) DO UPDATE SET name = $2, weight = $3, enabled = $4, sensitive = $5, sort = $6`,
        [d.key, d.name, d.weight, d.enabled, d.sensitive, sort++]);
    }
    await audit(db, actor(req), { action: 'config.dimensions_change', entityType: 'growth_dimensions', before, after: body.dimensions });
    return { ok: true, note: 'Scores are recalculated in the background with the new weights.' };
  }));

  app.get('/config/scoring', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'dimension:view', null);
    return { active: await one(db, `SELECT version, config, created_at FROM scoring_configs WHERE active`),
      history: await many(db, `SELECT version, created_at, created_by FROM scoring_configs ORDER BY version DESC LIMIT 20`) };
  }));

  app.put('/config/scoring', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'dimension:configure', null);
    const body = parse(z.object({ competencyWeight: z.number().min(0).max(1), engagementWeight: z.number().min(0).max(1),
      minConfidenceForFullWeight: z.number().min(0.05).max(1) }), req.body);
    const dims = await many(db, `SELECT key, weight, enabled, sensitive FROM growth_dimensions`);
    const errs = validateScoringConfig({ version: 0, ...body, dimensions: dims.map((d: any) => ({ ...d, weight: Number(d.weight) })) });
    if (errs.length) throw badRequest('Invalid scoring configuration', errs);
    const prev = await one<{ version: number; config: any }>(db, `SELECT version, config FROM scoring_configs WHERE active FOR UPDATE`);
    const version = (prev?.version ?? 0) + 1;
    await db.query(`UPDATE scoring_configs SET active = false WHERE active`);
    await db.query(`INSERT INTO scoring_configs (version, config, active, created_by) VALUES ($1,$2,true,$3)`, [version, JSON.stringify(body), auth.userId]);
    await audit(db, actor(req), { action: 'config.scoring_change', entityType: 'scoring_config', entityId: String(version), before: prev?.config, after: body });
    return { version };
  }));

  // ── Skill graph ──────────────────────────────────────────────────
  // The skill catalogue is not sensitive; any authenticated tenant member may read it.
  app.get('/skills', async (req) => tx(req, async (db) => {
    return { items: await many(db, `SELECT sk.id, sk.key, sk.name, sk.parent_id, sk.weight, d.key AS dimension FROM skills sk JOIN growth_dimensions d ON d.id = sk.dimension_id ORDER BY sk.name`) };
  }));

  app.post('/skills', async (req, reply) => tx(req, async (db, auth) => {
    authorize(auth, 'skill:create', null);
    const body = parse(z.object({ key: z.string().regex(/^[a-z0-9_.-]{2,60}$/), name: z.string().min(1).max(120), dimensionKey: z.string(),
      parentId: Uuid.optional(), description: z.string().max(2000).optional(), weight: z.number().min(0).max(10).default(1) }), req.body);
    const d = await one<{ id: string }>(db, `SELECT id FROM growth_dimensions WHERE key = $1`, [body.dimensionKey]);
    if (!d) throw badRequest('Unknown dimension');
    if (body.parentId && !(await one(db, `SELECT 1 FROM skills WHERE id = $1`, [body.parentId]))) throw notFound('Parent skill');
    const s = await one<{ id: string }>(db, `INSERT INTO skills (key, name, dimension_id, parent_id, description, weight) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [body.key, body.name, d.id, body.parentId ?? null, body.description ?? null, body.weight]);
    await audit(db, actor(req), { action: 'skill.create', entityType: 'skill', entityId: s!.id, after: body });
    return created(reply, { id: s!.id });
  }));

  // ── AI governance ────────────────────────────────────────────────
  app.get('/config/ai', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'ai:manage_ai', null);
    return { policy: (await one<any>(db, `SELECT ai FROM tenant_policies`))?.ai ?? {},
      models: await many(db, `SELECT feature, provider, model, enabled, params FROM ai_model_configs ORDER BY feature`) };
  }));

  app.put('/config/ai', async (req) => tx(req, async (db, auth) => {
    authorize(auth, 'ai:manage_ai', null);
    const body = parse(z.object({
      policy: z.object({ enabled: z.boolean(), requireConsent: z.boolean(), dailyCallLimit: z.number().int().positive().optional() }).optional(),
      models: z.array(z.object({ feature: z.enum(['*', 'task_generation', 'evaluation', 'mentor', 'speaking', 'interview', 'teacher_assistant', 'content']),
        provider: z.enum(['anthropic', 'mock']), model: z.string().min(1).max(100), enabled: z.boolean().default(true) })).optional(),
    }), req.body);
    const before = { policy: (await one<any>(db, `SELECT ai FROM tenant_policies`))?.ai, models: await many(db, `SELECT feature, provider, model, enabled FROM ai_model_configs`) };
    if (body.policy) {
      await db.query(`INSERT INTO tenant_policies (ai) VALUES ($1) ON CONFLICT (tenant_id) DO UPDATE SET ai = $1, updated_at = now()`, [JSON.stringify(body.policy)]);
    }
    for (const m of body.models ?? []) {
      await db.query(`INSERT INTO ai_model_configs (feature, provider, model, enabled) VALUES ($1,$2,$3,$4)
                      ON CONFLICT (tenant_id, feature) DO UPDATE SET provider = $2, model = $3, enabled = $4`, [m.feature, m.provider, m.model, m.enabled]);
    }
    await audit(db, actor(req), { action: 'config.ai_change', entityType: 'ai_config', before, after: body });
    return { ok: true };
  }));
}
