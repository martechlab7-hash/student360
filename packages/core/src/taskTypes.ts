/**
 * Task type registry. New types are added here (plus a payload schema in the API layer) —
 * no database redesign is needed because task content and submissions are typed JSON.
 */

import type { EvidenceSource } from './evidence.js';

export type EvaluationStrategy = 'auto' | 'ai' | 'teacher' | 'sandbox' | 'system' | 'ai_then_teacher';

export interface TaskTypeDef {
  key: string;
  label: string;
  defaultEvaluation: EvaluationStrategy;
  evidenceSource: EvidenceSource;
  /** Participation-only types generate evidence but only a small engagement signal. */
  competencySignal: boolean;
  /** Weight of the resulting skill signal (standardised assessments are weighted higher elsewhere). */
  signalWeight: number;
}

const T = (key: string, label: string, defaultEvaluation: EvaluationStrategy, evidenceSource: EvidenceSource, competencySignal = true, signalWeight = 1): TaskTypeDef =>
  ({ key, label, defaultEvaluation, evidenceSource, competencySignal, signalWeight });

export const TASK_TYPES: Record<string, TaskTypeDef> = Object.fromEntries([
  T('text_response', 'Text response', 'ai', 'system'),
  T('mcq', 'Multiple choice', 'auto', 'assessment'),
  T('quiz', 'Quiz', 'auto', 'assessment'),
  T('coding', 'Coding problem', 'sandbox', 'assessment', true, 1.2),
  T('sql', 'SQL problem', 'sandbox', 'assessment', true, 1.2),
  T('audio', 'Audio / speaking', 'ai', 'audio'),
  T('video', 'Video', 'ai_then_teacher', 'video'),
  T('image', 'Image', 'teacher', 'document'),
  T('file_upload', 'File upload', 'teacher', 'document'),
  T('assignment', 'Assignment', 'ai_then_teacher', 'document', true, 1.2),
  T('presentation', 'Presentation', 'teacher', 'teacher', true, 1.2),
  T('interview', 'Interview', 'ai', 'system', true, 1.2),
  T('viva', 'Viva', 'teacher', 'teacher', true, 1.2),
  T('practical', 'Practical', 'teacher', 'teacher', true, 1.2),
  T('lab', 'Lab experiment', 'ai_then_teacher', 'system', true, 1.2),
  T('event_participation', 'Event participation', 'system', 'qr', false, 0.2),
  T('attendance', 'Attendance', 'system', 'attendance_system', false, 0.1),
  T('reflection', 'Reflection', 'ai', 'system', true, 0.6),
  T('group_activity', 'Group activity', 'teacher', 'teacher', true, 0.8),
  T('external_activity', 'External activity', 'teacher', 'self_report', true, 0.5),
  T('teacher_evaluation', 'Teacher evaluation', 'teacher', 'teacher', true, 1.5),
  T('system_generated', 'System generated', 'system', 'system', false, 0.2),
  T('ai_conversation', 'AI conversation', 'ai', 'system', true, 0.8),
].map((t) => [t.key, t]));

export function getTaskType(key: string): TaskTypeDef | undefined {
  return TASK_TYPES[key];
}
