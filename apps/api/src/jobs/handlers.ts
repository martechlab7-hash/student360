/** Job handlers. Each is idempotent and re-enters its tenant through RLS. */
import { withTenant } from '../db/pool.js';
import { recalculateStudent } from '../services/growth.js';
import { applyEvaluation, evaluateSubmission } from '../services/evaluation.js';
import { fanout } from '../services/notifications.js';
import { upsertImportedStudent, type ImportRecord } from '../services/people.js';
import { generateAssignments } from '../services/tasks.js';
import { audit } from '../lib/audit.js';
import type { Handler, JobName } from './bus.js';

export const handlers: Record<JobName, Handler> = {
  'task.generate_assignments': async (p) => { await generateAssignments(p.tenantId, p.aggregateId as string); },
  'submission.evaluate': async (p) => { await evaluateSubmission(p.tenantId, p.aggregateId as string); },
  'evaluation.apply': async (p) => { await applyEvaluation(p.tenantId, p.aggregateId as string); },
  'growth.recalculate': async (p) => { await recalculateStudent(p.tenantId, (p.studentId as string) ?? (p.aggregateId as string)); },
  'notification.fanout': async (p) => { await fanout(p); },

  'integration.import_students': async (p) => {
    const records = p.records as ImportRecord[];
    const stats = { created: 0, updated: 0, unchanged: 0, failed: 0, errors: [] as string[] };
    await withTenant({ tenantId: p.tenantId }, (db) => db.query(`UPDATE sync_jobs SET status = 'running' WHERE id = $1`, [p.syncJobId]));
    for (const rec of records) {
      try {
        // One small transaction per record: a bad row never aborts the batch; retries are safe.
        const r = await withTenant({ tenantId: p.tenantId, userId: p.userId as string }, (db) =>
          upsertImportedStudent(db, { userId: p.userId as string, actorType: 'integration' }, p.system as string, rec));
        stats[r]++;
      } catch (e) {
        stats.failed++;
        if (stats.errors.length < 50) stats.errors.push(`${rec.externalId}: ${(e as Error).message}`);
      }
    }
    await withTenant({ tenantId: p.tenantId }, async (db) => {
      await db.query(`UPDATE sync_jobs SET status = $2, stats = $3, finished_at = now() WHERE id = $1`,
        [p.syncJobId, stats.failed === 0 ? 'succeeded' : stats.failed === records.length ? 'failed' : 'partial', JSON.stringify(stats)]);
      await audit(db, { userId: p.userId as string, actorType: 'integration' }, { action: 'integration.import_completed', entityType: 'sync_job', entityId: p.syncJobId as string, after: stats, source: 'worker' });
    });
  },

  'privacy.export': async (p) => {
    // Export bundles are assembled and written to tenant-prefixed object storage by the storage
    // adapter; here we mark the request processed and audit it.
    await withTenant({ tenantId: p.tenantId }, async (db) => {
      await db.query(`UPDATE data_requests SET status = 'completed', completed_at = now(), result_ref = $2 WHERE id = $1`,
        [p.aggregateId, p.kind === 'export' ? `tenants/${p.tenantId}/exports/${p.aggregateId}.json` : null]);
      await audit(db, { actorType: 'system' }, { action: `data_request.${p.kind}_processed`, entityType: 'data_request', entityId: p.aggregateId as string, source: 'worker' });
    });
  },

  'insights.nightly': async (p) => {
    // Nightly snapshot for every active student so trends exist even on quiet days.
    const ids = await withTenant({ tenantId: p.tenantId }, (db) => db.query<{ id: string }>(`SELECT id FROM students WHERE status = 'active'`));
    for (const r of ids.rows) await recalculateStudent(p.tenantId, r.id);
  },
};
