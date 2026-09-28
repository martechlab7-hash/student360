/**
 * AI Gateway — the only entry point business code uses for AI.
 *
 * Responsibilities: resolve the tenant-approved provider/model for a feature, enforce AI
 * governance (tenant switch, consent, daily quota), render versioned prompts, validate the
 * structured output, retry transient failures, and record every call (tokens, latency, cost,
 * prompt version, outcome) in ai_interactions for cost monitoring and audit.
 */
import type { z } from 'zod';
import { config } from '../config.js';
import { one, withTenant, type Db } from '../db/pool.js';
import { sha256, stableStringify } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { PROMPTS, type PromptDef, type PromptName } from './prompts.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { MockProvider } from './providers/mock.js';
import { AIInvalidOutputError, AIRefusalError, AIRetryableError, type AIMessage, type AIProvider } from './types.js';

/** USD per million tokens (input, output). Unknown models are logged with null cost. */
const PRICING: Record<string, [number, number]> = {
  'claude-opus-5': [5, 25],
  'claude-opus-5-5': [4, 20],
  'claude-fable-5-1': [10, 50],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
};

export interface AIContext {
  tenantId: string;
  userId?: string | null;
  /** When the call processes a specific student's data, consent/policy is enforced for them. */
  studentId?: string | null;
  inputRef?: string;
}

export interface AIResult<T> {
  output: T;
  interactionId: string;
  provider: string;
  model: string;
  promptKey: string;
  promptVersion: string;
}

const providers = new Map<string, AIProvider>();
function provider(name: string): AIProvider {
  let p = providers.get(name);
  if (!p) {
    if (name === 'anthropic') p = new AnthropicProvider(config.ANTHROPIC_API_KEY);
    else if (name === 'mock') p = new MockProvider();
    else throw new AppError(500, 'AI_PROVIDER_UNKNOWN', `Unknown AI provider ${name}`);
    providers.set(name, p);
  }
  return p;
}

/** Test hook: swap a provider implementation (e.g. a failing or golden-dataset provider). */
export function registerProvider(p: AIProvider) {
  providers.set(p.name, p);
}

async function resolveModel(db: Db, feature: string) {
  const row = await one<{ provider: string; model: string; enabled: boolean; params: Record<string, unknown> }>(
    db,
    `SELECT provider, model, enabled, params FROM ai_model_configs
      WHERE feature IN ($1, '*') ORDER BY (feature = $1) DESC LIMIT 1`,
    [feature],
  );
  return row ?? { provider: config.AI_DEFAULT_PROVIDER, model: config.AI_DEFAULT_MODEL, enabled: true, params: {} };
}

async function enforceGovernance(db: Db, ctx: AIContext) {
  const ai = (await one<{ ai: any }>(db, `SELECT ai FROM tenant_policies`))?.ai ?? {};
  if (ai.enabled === false) throw new AppError(403, 'AI_DISABLED', 'AI features are disabled for this institution');
  if (ctx.studentId && ai.requireConsent) {
    const c = await one<{ granted: boolean }>(
      db,
      `SELECT granted FROM consents WHERE subject_student_id = $1 AND purpose = 'ai_processing' ORDER BY created_at DESC LIMIT 1`,
      [ctx.studentId],
    );
    if (!c?.granted) throw new AppError(403, 'CONSENT_REQUIRED', 'AI processing consent has not been granted for this student');
  }
  if (typeof ai.dailyCallLimit === 'number') {
    const u = await one<{ value: number }>(db, `SELECT value FROM usage_counters WHERE metric = 'ai_calls' AND period = current_date`);
    if ((u?.value ?? 0) >= ai.dailyCallLimit) throw new AppError(429, 'AI_QUOTA_EXCEEDED', 'Daily AI quota reached for this institution');
  }
}

/**
 * Runs a registered prompt. Uses its own short transactions for governance and logging so a
 * slow model call never holds a caller's database transaction or connection open.
 */
export async function runPrompt<N extends PromptName>(
  ctx: AIContext,
  name: N,
  vars: Record<string, unknown>,
  history: AIMessage[] = [],
): Promise<AIResult<z.infer<(typeof PROMPTS)[N]['schema']>>> {
  const def = PROMPTS[name] as unknown as PromptDef<any>;
  const cfg = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, async (db) => {
    await enforceGovernance(db, ctx);
    return resolveModel(db, def.feature);
  });
  if (!cfg.enabled) throw new AppError(403, 'AI_FEATURE_DISABLED', `AI feature ${def.feature} is disabled`);

  const p = provider(cfg.provider);
  const messages: AIMessage[] = [...history, { role: 'user', content: def.render(vars) }];
  const requestHash = sha256(stableStringify({ k: def.key, v: def.version, vars, m: cfg.model }));
  const started = Date.now();
  let retries = 0;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await p.generate({
        model: cfg.model, system: def.system, messages, schema: def.schema, maxTokens: def.maxTokens,
        effort: def.effort, promptKey: def.key, vars, params: cfg.params,
      });
      const output = def.schema.parse(res.output);
      const interactionId = await logInteraction(ctx, {
        feature: def.feature, provider: p.name, model: res.model, promptKey: def.key, promptVersion: def.version,
        requestHash, output, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
        latencyMs: Date.now() - started, status: 'succeeded', retries,
      });
      return { output, interactionId, provider: p.name, model: res.model, promptKey: def.key, promptVersion: def.version };
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof AIRetryableError || err instanceof AIInvalidOutputError || (err as any)?.name === 'ZodError';
      if (!retryable || attempt === 2) break;
      retries++;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }

  const status = lastErr instanceof AIRefusalError ? 'refused' : lastErr instanceof AIInvalidOutputError || (lastErr as any)?.name === 'ZodError' ? 'invalid_output' : 'failed';
  await logInteraction(ctx, {
    feature: def.feature, provider: p.name, model: cfg.model, promptKey: def.key, promptVersion: def.version, requestHash,
    output: null, latencyMs: Date.now() - started, status, retries, error: (lastErr as Error)?.message?.slice(0, 500),
  });
  if (status === 'refused') throw new AppError(422, 'AI_REFUSED', 'The AI model declined this request');
  throw new AppError(503, 'AI_UNAVAILABLE', 'The AI service is temporarily unavailable. Please try again.');
}

interface InteractionLog {
  feature: string; provider: string; model: string; promptKey: string; promptVersion: string; requestHash: string;
  output: unknown; inputTokens?: number; outputTokens?: number; latencyMs: number; status: string; retries: number; error?: string;
}

/** Logged in its own transaction so the record survives even if the caller's transaction rolls back. */
async function logInteraction(ctx: AIContext, l: InteractionLog): Promise<string> {
  const base = l.model.replace(/^mock:/, '');
  const price = PRICING[base];
  const cost = price && l.inputTokens != null && l.outputTokens != null && !l.model.startsWith('mock:')
    ? (l.inputTokens * price[0] + l.outputTokens * price[1]) / 1e6 : null;
  return withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, async (db) => {
    const r = await one<{ id: string }>(
      db,
      `INSERT INTO ai_interactions (user_id, feature, provider, model, prompt_key, prompt_version, input_ref, request_hash,
         output, input_tokens, output_tokens, latency_ms, cost_usd, status, error, retries)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [ctx.userId ?? null, l.feature, l.provider, l.model, l.promptKey, l.promptVersion, ctx.inputRef ?? null, l.requestHash,
        l.output == null ? null : JSON.stringify(l.output), l.inputTokens ?? null, l.outputTokens ?? null, l.latencyMs, cost,
        l.status, l.error ?? null, l.retries],
    );
    await db.query(
      `INSERT INTO usage_counters (metric, period, value) VALUES ('ai_calls', current_date, 1)
       ON CONFLICT (tenant_id, metric, period) DO UPDATE SET value = usage_counters.value + 1`,
    );
    return r!.id;
  });
}
