import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  /** Runtime connection — must be a role WITHOUT BYPASSRLS (s360_app). */
  DATABASE_URL: z.string().default('postgres://s360_app:s360_app_dev@localhost:5432/student360'),
  /** Owner connection — migrations, tenant provisioning, outbox relay only. */
  DATABASE_ADMIN_URL: z.string().default('postgres://s360_owner:s360_owner_dev@localhost:5432/student360'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** 'bullmq' in production; 'inline' runs jobs in-process (tests / single-node dev). */
  JOB_MODE: z.enum(['bullmq', 'inline']).default('bullmq'),
  JWT_SECRET: z.string().min(32).default('dev-only-jwt-secret-change-me-please-000000'),
  JWT_ISSUER: z.string().default('student360'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(14),
  /** 32-byte base64 key for AES-256-GCM field encryption (MFA secrets, integration creds). */
  DATA_ENCRYPTION_KEY: z.string().default('ZGV2LW9ubHktZGF0YS1lbmNyeXB0aW9uLWtleS0zMmI='),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(300),
  /** Scales every rate limit (tests use a large value). */
  RATE_LIMIT_MULTIPLIER: z.coerce.number().positive().default(1),
  AI_DEFAULT_PROVIDER: z.enum(['anthropic', 'mock']).default('mock'),
  AI_DEFAULT_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** External sandbox (Judge0-compatible). Student code is NEVER executed on app servers. */
  CODE_SANDBOX_URL: z.string().optional(),
  CODE_SANDBOX_TOKEN: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  /** Secret used by platform operators to provision tenants (from the secrets manager). */
  PLATFORM_ADMIN_TOKEN: z.string().min(24).optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  if (cfg.NODE_ENV === 'production') {
    const insecure: string[] = [];
    if (cfg.JWT_SECRET.startsWith('dev-only')) insecure.push('JWT_SECRET');
    if (cfg.DATA_ENCRYPTION_KEY === Env.shape.DATA_ENCRYPTION_KEY.parse(undefined)) insecure.push('DATA_ENCRYPTION_KEY');
    if (insecure.length) throw new Error(`Refusing to start in production with default secrets: ${insecure.join(', ')}`);
  }
  return cfg;
}

export const config = loadConfig();
