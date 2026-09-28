import { config } from './config.js';
import { closePools } from './db/pool.js';
import { buildApp } from './http/app.js';
import { BullBus, InlineBus } from './jobs/bus.js';
import { handlers } from './jobs/handlers.js';
import { relayOutbox } from './jobs/relay.js';

const bus = config.JOB_MODE === 'inline' ? new InlineBus(() => handlers) : new BullBus();
const app = await buildApp({ bus });

// In inline mode (single-node dev), the API process also relays the outbox and runs jobs.
let timer: NodeJS.Timeout | undefined;
if (bus instanceof InlineBus) {
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { while ((await relayOutbox(bus)) > 0) await bus.drain(); await bus.drain(); } catch (e) { app.log.error(e); } finally { busy = false; }
  }, 1000);
}

await app.listen({ port: config.PORT, host: config.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await app.close();
    await bus.close();
    await closePools();
    process.exit(0);
  });
}
