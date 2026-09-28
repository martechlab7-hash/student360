import type { z } from 'zod';

export type Effort = 'low' | 'medium' | 'high';

export interface AIMessage { role: 'user' | 'assistant'; content: string }

export interface AIRequest<T> {
  model: string;
  system: string;
  messages: AIMessage[];
  schema: z.ZodType<T>;
  maxTokens: number;
  effort: Effort;
  /** For deterministic providers (mock) and tracing. */
  promptKey: string;
  vars: Record<string, unknown>;
  params?: Record<string, unknown>;
}

export interface AIResponse<T> {
  output: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Any model vendor is plugged in behind this interface; business logic never imports a vendor SDK. */
export interface AIProvider {
  readonly name: string;
  generate<T>(req: AIRequest<T>): Promise<AIResponse<T>>;
}

export class AIRefusalError extends Error {}
export class AIInvalidOutputError extends Error {}
export class AIRetryableError extends Error {}
