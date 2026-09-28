import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { loadPrincipal } from '../auth/principal.js';
import { verifyToken } from '../auth/tokens.js';
import { config } from '../config.js';
import { one, withTenant } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import type { JobBus } from '../jobs/bus.js';
import { adminRoutes } from '../modules/admin.js';
import { aiRoutes } from '../modules/ai.js';
import { authRoutes } from '../modules/auth.js';
import { dashboardRoutes } from '../modules/dashboards.js';
import { evaluationRoutes } from '../modules/evaluations.js';
import { eventRoutes } from '../modules/events.js';
import { evidenceRoutes } from '../modules/evidence.js';
import { growthRoutes } from '../modules/growth.js';
import { interventionRoutes } from '../modules/interventions.js';
import { miscRoutes } from '../modules/misc.js';
import { parentRoutes } from '../modules/parent.js';
import { platformRoutes } from '../modules/platform.js';
import { studentRoutes } from '../modules/students.js';
import { taskRoutes } from '../modules/tasks.js';
import { registerIdempotency } from './idempotency.js';

export async function buildApp(opts: { bus: JobBus; logger?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.LOG_LEVEL,
      // Never log credentials or tokens.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-platform-token"]', 'res.headers["set-cookie"]'],
    },
    genReqId: (req) => (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length < 100 ? req.headers['x-request-id'] : randomUUID()),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  app.decorateRequest('auth', null);
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  await app.register(cors, { origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true,
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id', 'x-s360-csrf', 'x-client-type'] });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: Math.ceil(config.RATE_LIMIT_PER_MINUTE * config.RATE_LIMIT_MULTIPLIER),
    timeWindow: '1 minute',
    // Per user when authenticated (tenant-qualified), else per IP.
    keyGenerator: (req) => (req.auth ? `${req.auth.tenantId}:${req.auth.userId}` : req.ip),
  });

  // Authentication: every route is private unless it opts out with config.public.
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) {
      if (!req.routeOptions.config?.public && req.routeOptions.url) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
      return;
    }
    const claims = await verifyToken(h.slice(7), 'access');
    req.auth = await withTenant({ tenantId: claims.tid, userId: claims.sub }, async (db) => {
      const s = await one<{ ok: boolean }>(db,
        `SELECT (s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active') AS ok
           FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.user_id = $2`, [claims.sid, claims.sub]);
      if (!s?.ok) throw new AppError(401, 'SESSION_REVOKED', 'Session is no longer valid');
      return { principal: await loadPrincipal(db, claims.sub, claims.tid), userId: claims.sub, tenantId: claims.tid, sessionId: claims.sid, kind: claims.kind };
    });
  });

  registerIdempotency(app);

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Validation failed', details: err.issues, requestId } });
    }
    const e = err as { statusCode?: number; code?: string; message: string; validation?: unknown };
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId } });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message, requestId } });
    if ((e as any).code === '23505') return reply.code(409).send({ error: { code: 'CONFLICT', message: 'Resource already exists', requestId } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong', requestId } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } }));

  await app.register(async (v1) => {
    await v1.register(authRoutes);
    await v1.register(platformRoutes);
    await v1.register(adminRoutes);
    await v1.register(studentRoutes);
    await v1.register(taskRoutes);
    await v1.register(evaluationRoutes);
    await v1.register(evidenceRoutes);
    await v1.register(growthRoutes);
    await v1.register(aiRoutes);
    await v1.register(eventRoutes);
    await v1.register(interventionRoutes);
    await v1.register(parentRoutes);
    await v1.register(dashboardRoutes);
    await v1.register(miscRoutes, { bus: opts.bus });
  }, { prefix: '/api/v1' });

  return app;
}
