/**
 * Outbox relay: moves committed domain events into the job bus.
 * Reads the outbox across tenants with the privileged pool (SKIP LOCKED so multiple relays can
 * run), then every handler re-enters its tenant through RLS with the runtime role.
 */
import { withPlatform } from '../db/pool.js';
import type { DomainEventType } from '../lib/outbox.js';
import type { JobBus, JobName } from './bus.js';

interface OutboxRow { id: number; tenant_id: string; type: DomainEventType; aggregate_type: string; aggregate_id: string; payload: Record<string, unknown> }

function growthKey(e: OutboxRow) {
  const student = (e.payload.studentId as string | undefined) ?? e.aggregate_id;
  return `growth:${e.tenant_id}:${student}:${Math.floor(Date.now() / 5000)}`;
}

/** Event → jobs routing table (the only place that wires modules together). */
export const SUBSCRIPTIONS: Partial<Record<DomainEventType, { job: JobName; dedupe?: (e: OutboxRow) => string; delayMs?: number }[]>> = {
  'task.published': [{ job: 'task.generate_assignments' }],
  'task.assigned': [{ job: 'notification.fanout' }],
  'submission.created': [{ job: 'submission.evaluate' }],
  'evaluation.needs_review': [{ job: 'notification.fanout' }],
  'evaluation.finalized': [{ job: 'evaluation.apply' }, { job: 'notification.fanout' }],
  // Growth recalculation is debounced per student: events within the same 5 s bucket → one job.
  'growth.recalculate': [{ job: 'growth.recalculate', dedupe: growthKey, delayMs: 2000 }],
  'evidence.verified': [{ job: 'growth.recalculate', dedupe: growthKey, delayMs: 2000 }],
  'attendance.recorded': [{ job: 'growth.recalculate', dedupe: growthKey, delayMs: 2000 }],
  'attendance.flagged': [{ job: 'notification.fanout' }],
  'intervention.changed': [{ job: 'notification.fanout' }],
  'recommendation.created': [{ job: 'notification.fanout' }],
  'growth.updated': [{ job: 'notification.fanout' }],
  'data_request.approved': [{ job: 'privacy.export' }],
};

export async function relayOutbox(bus: JobBus, batch = 200): Promise<number> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<OutboxRow>(
      `SELECT id, tenant_id, type, aggregate_type, aggregate_id, payload FROM outbox_events
        WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    for (const e of rows) {
      for (const sub of SUBSCRIPTIONS[e.type] ?? []) {
        await bus.enqueue(sub.job, {
          tenantId: e.tenant_id, eventId: e.id, eventType: e.type,
          aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, ...e.payload,
        }, { jobId: sub.dedupe ? sub.dedupe(e) : `evt:${e.id}:${sub.job}`, delayMs: sub.delayMs });
      }
    }
    if (rows.length) {
      await db.query(`UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    }
    return rows.length;
  });
}
