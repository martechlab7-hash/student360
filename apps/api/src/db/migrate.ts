import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';
import { pgOptions } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(connectionString = config.DATABASE_ADMIN_URL, log = console.log) {
  const client = new pg.Client(pgOptions(connectionString));
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // The owner connection must bypass RLS: provisioning and the outbox relay work across tenants.
    const role = (await client.query(`SELECT current_user AS name, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
    if (!role?.rolbypassrls) {
      throw new Error(`DATABASE_ADMIN_URL role "${role?.name}" lacks BYPASSRLS; use the database owner (on Supabase: the "postgres" role).`);
    }
    // Serialise concurrent deploys.
    await client.query('SELECT pg_advisory_lock(360360)');
    const dir = join(here, 'migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = await readFile(join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`applied ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(360360)').catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
