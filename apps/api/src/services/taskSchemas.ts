/** Per-type content and submission schemas. Adding a task type = adding entries here + in core TASK_TYPES. */
import { z } from 'zod';

const Text = z.object({ text: z.string().min(1).max(20_000) });
const File = z.object({ fileRef: z.string().min(1).max(500), note: z.string().max(2000).optional() });
const Media = z.object({
  mediaRef: z.string().max(500).optional(),
  /** Transcript from the speech-to-text pipeline (or on-device recognition). */
  transcript: z.string().max(20_000).optional(),
  durationSeconds: z.number().min(0).max(7200).optional(),
}).refine((v) => v.mediaRef || v.transcript, 'mediaRef or transcript is required');
const Code = z.object({ language: z.string().min(1).max(30), code: z.string().min(1).max(100_000) });

export const SUBMISSION_SCHEMAS: Record<string, z.ZodType> = {
  text_response: Text, reflection: Text, assignment: z.union([Text, File]), ai_conversation: Text, interview: Text,
  mcq: z.object({ answerIndex: z.number().int().min(0).max(20) }),
  quiz: z.object({ answers: z.array(z.number().int().min(0).max(20)).max(200) }),
  coding: Code, sql: z.object({ language: z.literal('sql').default('sql'), code: z.string().min(1).max(50_000) }),
  audio: Media, video: Media,
  image: File, file_upload: File, presentation: File, lab: z.union([Text, File]),
  practical: z.union([Text, File]), viva: z.union([Text, Media]),
  group_activity: z.union([Text, File]), external_activity: z.union([Text, File]),
  event_participation: z.object({ note: z.string().max(2000).optional() }),
  attendance: z.object({}).passthrough(), teacher_evaluation: z.object({}).passthrough(), system_generated: z.object({}).passthrough(),
};

export const CONTENT_SCHEMAS: Record<string, z.ZodType> = {
  mcq: z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).min(2).max(10), answerIndex: z.number().int().min(0) })
    .refine((c) => c.answerIndex < c.options.length, 'answerIndex out of range'),
  quiz: z.object({ questions: z.array(z.object({ question: z.string(), options: z.array(z.string()).min(2), answerIndex: z.number().int().min(0) })).min(1) }),
  coding: z.object({ problem: z.string().optional(), starterCode: z.string().optional(), language: z.string().default('python'),
    testCases: z.array(z.object({ input: z.string(), expectedOutput: z.string(), hidden: z.boolean().default(true) })).default([]) }).passthrough(),
};

/** Remove answer keys / hidden tests before content is shown to a student. */
export function redactForStudent(type: string, content: any): any {
  if (!content || typeof content !== 'object') return content;
  const c = structuredClone(content);
  if (type === 'mcq') delete c.answerIndex;
  if (type === 'quiz' && Array.isArray(c.questions)) c.questions = c.questions.map(({ answerIndex: _a, ...q }: any) => q);
  if ((type === 'coding' || type === 'sql') && Array.isArray(c.testCases)) c.testCases = c.testCases.filter((t: any) => !t.hidden);
  return c;
}

export const DEFAULT_RUBRICS: Record<string, { name: string; description: string; maxPoints: number }[]> = {
  audio: [
    { name: 'Fluency', description: 'Flow of speech without long hesitations', maxPoints: 20 },
    { name: 'Grammar', description: 'Grammatical accuracy', maxPoints: 15 },
    { name: 'Vocabulary', description: 'Range and precision of vocabulary', maxPoints: 15 },
    { name: 'Pronunciation', description: 'Clarity of pronunciation (requires audio analysis)', maxPoints: 10 },
    { name: 'Structure', description: 'Clear position, reasons and conclusion', maxPoints: 20 },
    { name: 'Relevance', description: 'Stays on the given topic', maxPoints: 20 },
  ],
  default: [
    { name: 'Relevance', description: 'Addresses the task objective', maxPoints: 30 },
    { name: 'Quality', description: 'Accuracy and depth of the response', maxPoints: 40 },
    { name: 'Clarity', description: 'Clear structure and expression', maxPoints: 30 },
  ],
};
