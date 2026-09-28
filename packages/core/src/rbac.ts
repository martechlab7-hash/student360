/**
 * Permission engine.
 *
 * Permissions are data (`resource:action` keys), roles are tenant-configurable bundles of
 * permissions, and every role assignment is bound to a scope in the organisation hierarchy.
 * Business code never checks role names — it asks `can(principal, permission, target)`.
 */

export const ACTIONS = [
  'view', 'create', 'edit', 'delete', 'publish', 'evaluate', 'approve',
  'export', 'configure', 'manage_ai', 'manage_integrations',
] as const;
export type Action = (typeof ACTIONS)[number];

export const RESOURCES = [
  'tenant', 'org_unit', 'user', 'role', 'student', 'guardian', 'skill', 'dimension',
  'task', 'submission', 'evaluation', 'evidence', 'assessment', 'event', 'attendance',
  'growth', 'recommendation', 'intervention', 'project', 'content', 'report', 'analytics',
  'ai', 'integration', 'notification', 'audit', 'consent', 'billing',
] as const;
export type Resource = (typeof RESOURCES)[number];

export type PermissionKey = `${Resource}:${Action}`;

/** Scope levels, broadest first. `student` is used for self / guardian relationships. */
export const SCOPE_LEVELS = ['platform', 'tenant', 'campus', 'department', 'program', 'batch', 'section', 'student'] as const;
export type ScopeType = (typeof SCOPE_LEVELS)[number];

export interface ScopeRef {
  type: ScopeType;
  id: string;
}

export interface Grant {
  permissions: ReadonlySet<string>;
  scope: ScopeRef;
}

export interface Principal {
  userId: string;
  tenantId: string;
  grants: readonly Grant[];
}

/**
 * The target of a check is described by its ancestry chain, e.g. for a student:
 * [tenant, campus, department, program, batch, section, student].
 * An empty/undefined ancestry means "tenant-wide" (e.g. listing configuration).
 */
export interface Target {
  ancestry: readonly ScopeRef[];
}

function grantCovers(grant: Grant, target: Target | undefined): boolean {
  if (grant.scope.type === 'platform') return true;
  if (!target || target.ancestry.length === 0) {
    // Tenant-wide operation requires a tenant-level grant.
    return grant.scope.type === 'tenant';
  }
  return target.ancestry.some((a) => a.type === grant.scope.type && a.id === grant.scope.id);
}

function grantHas(grant: Grant, permission: string): boolean {
  if (grant.permissions.has(permission)) return true;
  const [resource] = permission.split(':');
  return grant.permissions.has(`${resource}:*`) || grant.permissions.has('*:*');
}

export function can(principal: Principal, permission: PermissionKey | string, target?: Target): boolean {
  return principal.grants.some((g) => grantHas(g, permission) && grantCovers(g, target));
}

/**
 * Returns the scopes in which the principal holds the permission. Repositories use this to
 * build row filters for list queries (e.g. "students in sections X, Y or department Z").
 */
export function scopesFor(principal: Principal, permission: PermissionKey | string): ScopeRef[] {
  return principal.grants.filter((g) => grantHas(g, permission)).map((g) => g.scope);
}

export function isValidPermissionKey(key: string): key is PermissionKey {
  const [r, a, ...rest] = key.split(':');
  if (rest.length > 0 || !r || !a) return false;
  return (RESOURCES as readonly string[]).includes(r) && ((ACTIONS as readonly string[]).includes(a) || a === '*');
}

/** Default role templates seeded per tenant; tenants may edit or add roles freely. */
export const DEFAULT_ROLE_TEMPLATES: Record<string, { name: string; permissions: string[] }> = {
  college_admin: { name: 'College Admin', permissions: ['*:*'] },
  institution_admin: {
    name: 'Institution Admin',
    permissions: RESOURCES.filter((r) => r !== 'billing').map((r) => `${r}:*`),
  },
  department_admin: {
    name: 'Department Admin',
    permissions: ['org_unit:view', 'org_unit:edit', 'user:view', 'user:create', 'student:*', 'task:*', 'assessment:*',
      'growth:view', 'analytics:view', 'report:view', 'report:export', 'intervention:*', 'event:*', 'attendance:*',
      'evidence:view', 'evidence:approve', 'content:*', 'skill:view', 'dimension:view'],
  },
  hod: {
    name: 'Head of Department',
    permissions: ['org_unit:view', 'student:view', 'task:view', 'task:approve', 'task:publish', 'assessment:view',
      'growth:view', 'analytics:view', 'report:view', 'report:export', 'intervention:*', 'evidence:view',
      'evidence:approve', 'evaluation:view', 'evaluation:approve', 'skill:view', 'dimension:view', 'event:view'],
  },
  teacher: {
    name: 'Teacher',
    permissions: ['org_unit:view', 'student:view', 'task:view', 'task:create', 'task:edit', 'task:publish',
      'submission:view', 'evaluation:view', 'evaluation:evaluate', 'evidence:view', 'evidence:approve',
      'assessment:view', 'assessment:create', 'assessment:edit', 'assessment:publish', 'growth:view',
      'recommendation:view', 'intervention:view', 'intervention:create', 'intervention:edit', 'content:*',
      'skill:view', 'dimension:view', 'ai:view', 'ai:create', 'event:view', 'attendance:view', 'project:view',
      'project:evaluate', 'analytics:view'],
  },
  mentor: {
    name: 'Mentor',
    permissions: ['student:view', 'growth:view', 'recommendation:view', 'recommendation:create', 'intervention:*',
      'evidence:view', 'task:view', 'task:create', 'submission:view', 'skill:view', 'dimension:view'],
  },
  placement_officer: {
    name: 'Placement Officer',
    permissions: ['student:view', 'growth:view', 'report:view', 'report:export', 'task:view', 'task:create',
      'task:publish', 'assessment:*', 'event:*', 'skill:view', 'analytics:view'],
  },
  event_coordinator: {
    name: 'Event Coordinator',
    permissions: ['event:*', 'attendance:*', 'student:view', 'evidence:view', 'evidence:create'],
  },
  lab_admin: { name: 'Lab Administrator', permissions: ['content:*', 'task:view', 'task:create', 'task:edit', 'skill:view'] },
  counsellor: {
    name: 'Counsellor',
    permissions: ['student:view', 'intervention:view', 'intervention:edit', 'growth:view', 'recommendation:view'],
  },
  external_evaluator: { name: 'External Evaluator', permissions: ['submission:view', 'evaluation:evaluate', 'project:evaluate'] },
  student: {
    name: 'Student',
    permissions: ['student:view', 'task:view', 'submission:create', 'submission:view', 'evaluation:view',
      'evidence:view', 'evidence:create', 'growth:view', 'recommendation:view', 'ai:create', 'event:view',
      'attendance:create', 'project:view', 'project:create', 'project:edit', 'consent:view', 'consent:edit',
      'skill:view', 'dimension:view', 'notification:view', 'intervention:view'],
  },
  parent: {
    name: 'Parent / Guardian',
    permissions: ['student:view', 'growth:view', 'recommendation:view', 'event:view', 'notification:view', 'consent:view', 'consent:edit'],
  },
};
