import type { Db } from '../db/pool.js';

export interface AuditEntry {
  action: string;            // e.g. 'evaluation.override', 'role.assign', 'auth.login'
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  source?: string;           // api | worker | integration | ai
}

export interface AuditActor {
  userId?: string | null;
  actorType?: 'user' | 'system' | 'integration';
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Appends to the immutable audit log inside the caller's transaction. */
export async function audit(db: Db, actor: AuditActor, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before, after, source, ip, user_agent, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [actor.userId ?? null, actor.actorType ?? 'user', e.action, e.entityType, e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after),
      e.source ?? 'api', actor.ip ?? null, actor.userAgent ?? null, actor.requestId ?? null],
  );
}
