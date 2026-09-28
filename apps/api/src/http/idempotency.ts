/**
 * Idempotency-Key support for unsafe requests (e.g. task submissions over flaky mobile networks).
 * The first request stores its response; retries with the same key replay it. A different body
 * with the same key is rejected.
 */
import type { FastifyInstance } from 'fastify';
import { withTenant } from '../db/pool.js';
import { sha256, stableStringify } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';

export function registerIdempotency(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.routeOptions.config?.idempotent || !req.auth) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 200) return;
    const hash = sha256(stableStringify({ url: req.url, body: req.body ?? null }));
    const { tenantId, userId } = req.auth;
    const existing = await withTenant({ tenantId, userId }, async (db) => {
      const r = await db.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, user_id, key) DO NOTHING RETURNING key`, [userId, key, hash]);
      if (r.rowCount) return null;
      return (await db.query(`SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [userId, key])).rows[0];
    });
    if (!existing) { (req as any).idempotencyKey = key; return; }
    if (existing.request_hash !== hash) throw new AppError(422, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key was reused with a different request');
    if (existing.response_status == null) throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
    reply.header('idempotent-replay', 'true');
    return reply.code(existing.response_status).send(existing.response_body);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const key = (req as any).idempotencyKey as string | undefined;
    if (!key || !req.auth) return payload;
    const { tenantId, userId } = req.auth;
    await withTenant({ tenantId, userId }, async (db) => {
      if (reply.statusCode >= 500) {
        await db.query(`DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [userId, key]); // allow retry
      } else {
        let body: unknown = null;
        try { body = typeof payload === 'string' ? JSON.parse(payload) : null; } catch { body = null; }
        await db.query(`UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE user_id = $1 AND key = $2`,
          [userId, key, reply.statusCode, JSON.stringify(body)]);
      }
    });
    return payload;
  });
}
