/**
 * Background worker: relays the transactional outbox into BullMQ and processes jobs.
 * Scale horizontally by running more worker processes; relays use SKIP LOCKED and jobs are idempotent.
 */
import pino from 'pino';
import { config } from './config.js';
import { closePools, withPlatform } from './db/pool.js';
import { BullBus, startBullWorker } from './jobs/bus.js';
import { handlers } from './jobs/handlers.js';
import { relayOutbox } from './jobs/relay.js';

const log = pino({ level: config.LOG_LEVEL });
const bus = new BullBus();
const worker = startBullWorker(handlers, Number(process.env.WORKER_CONCURRENCY ?? 10));
worker.on('failed', (job, err) => log.error({ job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));

let stopping = false;
async function relayLoop() {
  while (!stopping) {
    try {
      const n = await relayOutbox(bus);
      if (n === 0) await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      log.error({ err: (e as Error).message }, 'outbox relay error');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Nightly per-tenant snapshot job (02:00 UTC). BullMQ repeatable jobs are de-duplicated cluster-wide.
async function scheduleNightly() {
  const tenants = await withPlatform((db) => db.query<{ id: string }>(`SELECT id FROM tenants WHERE status = 'active'`));
  for (const t of tenants.rows) {
    const today = new Date().toISOString().slice(0, 10);
    await bus.enqueue('insights.nightly', { tenantId: t.id }, { jobId: `nightly:${t.id}:${today}`, delayMs: msUntil(2) });
  }
}
function msUntil(hourUtc: number) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

void relayLoop();
await scheduleNightly();
setInterval(() => void scheduleNightly().catch((e) => log.error(e)), 6 * 3600_000);
log.info('worker started');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopping = true;
    await worker.close();
    await bus.close();
    await closePools();
    process.exit(0);
  });
}
