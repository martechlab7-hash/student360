import pg from 'pg';
import { config } from '../config.js';

// numeric → number (scores are small, bounded values)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// int8 → number (counts)
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

/** Connection options with explicit TLS handling (see DATABASE_CA_CERT / DATABASE_SSL). */
export function pgOptions(connectionString: string): pg.ClientConfig {
  const mode = config.DATABASE_CA_CERT ? 'verify' : config.DATABASE_SSL;
  if (mode === 'off') return { connectionString };
  // An sslmode in the URL would override the ssl object below, so TLS is configured here only.
  const url = new URL(connectionString);
  for (const k of ['sslmode', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(k);
  return {
    connectionString: url.toString(),
    ssl: mode === 'verify'
      ? { ca: config.DATABASE_CA_CERT?.replace(/\\n/g, '\n'), rejectUnauthorized: true }
      : { rejectUnauthorized: false },
  };
}

export const appPool = new pg.Pool({ ...pgOptions(config.DATABASE_URL), max: config.DB_POOL_MAX });
export const adminPool = new pg.Pool({ ...pgOptions(config.DATABASE_ADMIN_URL), max: config.DB_ADMIN_POOL_MAX });

export type Db = pg.PoolClient;

export interface TenantContext {
  tenantId: string;
  userId?: string | null;
}

/**
 * Runs `fn` in a transaction bound to a tenant. Every tenant-owned table is protected by RLS on
 * `app.tenant_id`, so even a buggy query cannot read or write another tenant's rows.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [
      ctx.tenantId,
      ctx.userId ?? '',
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Privileged path. Only for tenant provisioning, migrations and the outbox relay. */
export async function withPlatform<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}

export async function closePools() {
  await Promise.allSettled([appPool.end(), adminPool.end()]);
}
