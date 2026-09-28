/**
 * Anthropic (Claude) adapter. Uses structured outputs so responses are schema-validated, and
 * server-side refusal fallbacks on models that support them.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AIInvalidOutputError, AIRefusalError, AIRetryableError, type AIProvider, type AIRequest, type AIResponse } from '../types.js';

const FALLBACK_CAPABLE = new Set(['claude-opus-5', 'claude-fable-5-1']);

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey?: string) {
    // Credentials come from the environment/secret manager, never from the browser.
    this.client = new Anthropic(apiKey ? { apiKey, maxRetries: 2 } : { maxRetries: 2 });
  }

  async generate<T>(req: AIRequest<T>): Promise<AIResponse<T>> {
    const useFallbacks = FALLBACK_CAPABLE.has(req.model) && req.params?.fallbacks !== false;
    try {
      const res = await this.client.beta.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages,
        output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema as any) },
        ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      if (res.stop_reason === 'refusal') throw new AIRefusalError('The model declined this request');
      if (res.stop_reason === 'max_tokens') throw new AIInvalidOutputError('Output truncated (max_tokens)');
      if (res.parsed_output == null) throw new AIInvalidOutputError('Structured output missing');
      return {
        output: res.parsed_output as T,
        model: res.model,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      };
    } catch (err) {
      if (err instanceof AIRefusalError || err instanceof AIInvalidOutputError) throw err;
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
        throw new AIRetryableError((err as Error).message);
      }
      throw err;
    }
  }
}
