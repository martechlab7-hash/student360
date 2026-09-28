/**
 * Tenant provisioning (platform-level). Creates a fully configured tenant: default roles,
 * development dimensions, scoring config, AI defaults and the first admin — all as data, so every
 * institution can then reconfigure without code changes.
 */
import { ACTIONS, DEFAULT_DIMENSIONS, DEFAULT_ROLE_TEMPLATES, DEFAULT_SCORING_CONFIG, RESOURCES } from '@s360/core';
import { hashPassword, passwordPolicyErrors } from '../auth/passwords.js';
import { config } from '../config.js';
import { one, withPlatform, withTenant, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict } from '../lib/errors.js';

export async function ensurePermissionCatalogue(db: Db) {
  const keys: string[] = [];
  for (const r of RESOURCES) for (const a of [...ACTIONS, '*']) keys.push(`${r}:${a}`);
  keys.push('*:*');
  await db.query(`INSERT INTO permissions (key) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`, [keys]);
}

export interface ProvisionInput {
  slug: string;
  name: string;
  admin: { email: string; fullName: string; password: string };
  settings?: Record<string, unknown>;
}

export async function provisionTenant(input: ProvisionInput, actorUserId?: string | null) {
  const errs = passwordPolicyErrors(input.admin.password, input.admin.email);
  if (errs.length) throw badRequest('Admin password does not meet policy', errs);

  const tenantId = await withPlatform(async (db) => {
    await ensurePermissionCatalogue(db);
    const exists = await one(db, `SELECT 1 FROM tenants WHERE slug = $1`, [input.slug]);
    if (exists) throw conflict('Tenant slug already in use');
    const t = await one<{ id: string }>(
      db,
      `INSERT INTO tenants (slug, name, settings) VALUES ($1,$2,$3) RETURNING id`,
      [input.slug, input.name, JSON.stringify(input.settings ?? {})],
    );
    return t!.id;
  });

  const passwordHash = await hashPassword(input.admin.password);
  return withTenant({ tenantId }, async (db) => {
    await db.query(`INSERT INTO subscriptions (tenant_id) VALUES ($1)`, [tenantId]);
    await db.query(`INSERT INTO tenant_policies (tenant_id) VALUES ($1)`, [tenantId]);

    const roleIds: Record<string, string> = {};
    for (const [key, tpl] of Object.entries(DEFAULT_ROLE_TEMPLATES)) {
      const r = await one<{ id: string }>(db, `INSERT INTO roles (key, name, is_system) VALUES ($1,$2,true) RETURNING id`, [key, tpl.name]);
      roleIds[key] = r!.id;
      await db.query(`INSERT INTO role_permissions (role_id, permission_key) SELECT $1, unnest($2::text[])`, [r!.id, tpl.permissions]);
    }

    let sort = 0;
    for (const d of DEFAULT_DIMENSIONS) {
      await db.query(`INSERT INTO growth_dimensions (key, name, weight, sensitive, sort) VALUES ($1,$2,$3,$4,$5)`,
        [d.key, d.name, d.weight, d.sensitive ?? false, sort++]);
    }
    await db.query(`INSERT INTO scoring_configs (version, config, active, created_by) VALUES (1, $1, true, $2)`,
      [JSON.stringify(DEFAULT_SCORING_CONFIG), actorUserId ?? null]);
    await db.query(`INSERT INTO ai_model_configs (feature, provider, model) VALUES ('*', $1, $2)`,
      [config.AI_DEFAULT_PROVIDER, config.AI_DEFAULT_MODEL]);

    const admin = await one<{ id: string }>(
      db,
      `INSERT INTO users (email, full_name, password_hash, kind) VALUES ($1,$2,$3,'staff') RETURNING id`,
      [input.admin.email, input.admin.fullName, passwordHash],
    );
    await db.query(`INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id) VALUES ($1,$2,'tenant',$3)`,
      [admin!.id, roleIds.college_admin, tenantId]);
    await audit(db, { userId: actorUserId, actorType: actorUserId ? 'user' : 'system' }, {
      action: 'tenant.provision', entityType: 'tenant', entityId: tenantId, after: { slug: input.slug, name: input.name }, source: 'platform',
    });
    return { tenantId, adminUserId: admin!.id, roleIds };
  });
}

export async function roleId(db: Db, key: string): Promise<string> {
  const r = await one<{ id: string }>(db, `SELECT id FROM roles WHERE key = $1`, [key]);
  if (!r) throw badRequest(`Unknown role ${key}`);
  return r.id;
}

/** Platform-only: permanently delete a tenant and all of its data (offboarding / contract end). */
export async function deleteTenant(tenantId: string) {
  await withPlatform(async (db) => {
    await db.query(`SELECT set_config('app.tenant_offboarding', 'on', true)`);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  });
}
