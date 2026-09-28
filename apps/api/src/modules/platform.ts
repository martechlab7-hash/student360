import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { created, parse, perMinute } from '../http/context.js';
import { provisionTenant } from '../services/tenancy.js';

/** Platform super-admin surface. Authenticated by a secret-managed operator token, not tenant JWTs. */
export async function platformRoutes(app: FastifyInstance) {
  app.post('/platform/tenants', { config: { public: true, rateLimit: perMinute(5) } }, async (req, reply) => {
    const token = req.headers['x-platform-token'];
    if (!config.PLATFORM_ADMIN_TOKEN || typeof token !== 'string' || !safeEqual(token, config.PLATFORM_ADMIN_TOKEN)) {
      throw new AppError(403, 'FORBIDDEN', 'Platform operator credentials required');
    }
    const body = parse(z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
      name: z.string().min(2).max(200),
      admin: z.object({ email: z.string().email(), fullName: z.string().min(1), password: z.string() }),
      settings: z.record(z.string(), z.unknown()).optional(),
    }), req.body);
    const r = await provisionTenant(body);
    return created(reply, { tenantId: r.tenantId, adminUserId: r.adminUserId });
  });
}
