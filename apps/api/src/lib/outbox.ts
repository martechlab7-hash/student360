import type { Db } from '../db/pool.js';

/**
 * Domain events. Written transactionally with the state change; the relay publishes them to
 * the job bus after commit. Business modules never call notifications/AI/growth directly.
 */
export type DomainEventType =
  | 'task.published'
  | 'task.assigned'
  | 'submission.created'
  | 'evaluation.finalized'
  | 'evaluation.needs_review'
  | 'evidence.created'
  | 'evidence.verified'
  | 'growth.recalculate'
  | 'growth.updated'
  | 'attendance.recorded'
  | 'attendance.flagged'
  | 'intervention.changed'
  | 'recommendation.created'
  | 'student.imported'
  | 'data_request.approved';

export async function emit(db: Db, type: DomainEventType, aggregateType: string, aggregateId: string, payload: Record<string, unknown> = {}) {
  await db.query(
    `INSERT INTO outbox_events (type, aggregate_type, aggregate_id, payload) VALUES ($1,$2,$3,$4)`,
    [type, aggregateType, aggregateId, JSON.stringify(payload)],
  );
}
