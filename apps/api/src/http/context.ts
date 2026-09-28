import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type PermissionKey, type Target } from '@s360/core';
import { z } from 'zod';
import type { AuthContext } from '../auth/principal.js';
import { studentTarget } from '../auth/principal.js';
import { withTenant, type Db } from '../db/pool.js';
import type { AuditActor } from '../lib/audit.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
    idempotent?: boolean;
  }
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Run a handler in a tenant-scoped transaction (RLS-enforced). */
export function tx<T>(req: FastifyRequest, fn: (db: Db, auth: AuthContext) => Promise<T>): Promise<T> {
  const auth = requireAuth(req);
  return withTenant({ tenantId: auth.tenantId, userId: auth.userId }, (db) => fn(db, auth));
}

export function actor(req: FastifyRequest): AuditActor {
  return {
    userId: req.auth?.userId ?? null,
    actorType: 'user',
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: req.id,
  };
}

export function authorize(auth: AuthContext, permission: PermissionKey | string, target?: Target | null): void {
  if (!can(auth.principal, permission, target ?? undefined)) throw forbidden();
}

/** True if the caller holds the permission in at least one scope (used for "my scoped items" listings). */
export function hasAnywhere(auth: AuthContext, permission: string): boolean {
  const [resource] = permission.split(':');
  return auth.principal.grants.some((g) => g.permissions.has(permission) || g.permissions.has(`${resource}:*`) || g.permissions.has('*:*'));
}

export function requireAnywhere(auth: AuthContext, permission: string): void {
  if (!hasAnywhere(auth, permission)) throw forbidden();
}

/** Authorise an action on a specific student (resolves the student's org ancestry). */
export async function authorizeStudent(db: Db, auth: AuthContext, permission: PermissionKey | string, studentId: string) {
  const target = await studentTarget(db, auth.tenantId, studentId);
  // Same response for "missing" and "not yours" to avoid leaking existence.
  if (!target || !can(auth.principal, permission, target)) throw notFound('Student');
  return target;
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

/**
 * Marks the response 201 and returns the body. It deliberately does NOT call reply.send(): handlers
 * run inside a transaction, and the response must only go out after COMMIT succeeds.
 */
export const created = <T>(reply: FastifyReply, body: T): T => {
  reply.code(201);
  return body;
};

export const Uuid = z.string().uuid();
export const IdParams = z.object({ id: Uuid });

/** Per-route rate limit, e.g. `{ config: { rateLimit: perMinute(10) } }`. */
export const perMinute = (max: number) => ({ max: Math.ceil(max * config.RATE_LIMIT_MULTIPLIER), timeWindow: '1 minute' });
