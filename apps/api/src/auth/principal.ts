import type { Grant, Principal, ScopeRef, ScopeType, Target } from '@s360/core';
import { scopesFor } from '@s360/core';
import { many, type Db } from '../db/pool.js';

export interface AuthContext {
  principal: Principal;
  userId: string;
  tenantId: string;
  sessionId: string;
  kind: string;
}

export async function loadPrincipal(db: Db, userId: string, tenantId: string): Promise<Principal> {
  const rows = await many<{ scope_type: ScopeType; scope_id: string; perms: string[] }>(
    db,
    `SELECT ra.scope_type, ra.scope_id, array_agg(rp.permission_key) AS perms
       FROM role_assignments ra
       JOIN role_permissions rp ON rp.role_id = ra.role_id
      WHERE ra.user_id = $1
      GROUP BY ra.id, ra.scope_type, ra.scope_id`,
    [userId],
  );
  const grants: Grant[] = rows.map((r) => ({
    permissions: new Set(r.perms),
    scope: { type: r.scope_type, id: r.scope_type === 'tenant' ? tenantId : r.scope_id },
  }));
  return { userId, tenantId, grants };
}

/** Ancestry of a student: tenant → org units (root first) → student. */
export async function studentTarget(db: Db, tenantId: string, studentId: string): Promise<Target | null> {
  const rows = await many<{ unit_id: string; type: ScopeType; depth: number }>(
    db,
    `SELECT u.id AS unit_id, u.type, array_position(sec.path, u.id) AS depth
       FROM students s
       JOIN org_units sec ON sec.id = s.section_id
       JOIN org_units u ON u.id = ANY(sec.path)
      WHERE s.id = $1
      ORDER BY depth`,
    [studentId],
  );
  if (rows.length === 0) return null;
  return {
    ancestry: [{ type: 'tenant', id: tenantId }, ...rows.map((r) => ({ type: r.type, id: r.unit_id })), { type: 'student', id: studentId }],
  };
}

export async function orgUnitTarget(db: Db, tenantId: string, unitId: string): Promise<Target | null> {
  const rows = await many<{ id: string; type: ScopeType }>(
    db,
    `SELECT u.id, u.type FROM org_units t JOIN org_units u ON u.id = ANY(t.path)
      WHERE t.id = $1 ORDER BY array_position(t.path, u.id)`,
    [unitId],
  );
  if (rows.length === 0) return null;
  return { ancestry: [{ type: 'tenant', id: tenantId }, ...rows.map((r) => ({ type: r.type, id: r.id }))] };
}

/**
 * Builds a SQL predicate restricting a students query (alias `s`, section alias `sec`) to the
 * scopes in which the principal holds `permission`. Returns null when access is tenant-wide.
 */
export function studentScopeFilter(principal: Principal, permission: string, paramOffset: number):
  { sql: string; params: unknown[] } | null {
  const scopes: ScopeRef[] = scopesFor(principal, permission);
  if (scopes.some((s) => s.type === 'tenant' || s.type === 'platform')) return null;
  const studentIds = scopes.filter((s) => s.type === 'student').map((s) => s.id);
  const unitIds = scopes.filter((s) => s.type !== 'student').map((s) => s.id);
  return {
    sql: `(s.id = ANY($${paramOffset}::uuid[]) OR sec.path && $${paramOffset + 1}::uuid[])`,
    params: [studentIds, unitIds],
  };
}
