/**
 * Task mode resolution, adaptive difficulty, remediation and the advanced path.
 *
 * The teacher sets objective + constraints; this module decides — deterministically and with
 * an explanation — what difficulty each student should receive and whether they belong on the
 * remediation or advanced path. AI is only used afterwards to author content at that target.
 */

import { recommendedDifficulty, type SkillState } from './ability.js';
import { DIFFICULTY_LEVELS, levelCentre, levelForScore, type DifficultyLevel } from './difficulty.js';

export const TASK_MODES = ['STANDARDIZED', 'EQUIVALENT', 'ADAPTIVE', 'PERSONALIZED'] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export type ProgressionPath = 'standard' | 'remediation' | 'advanced';

export interface ProgressionDecision {
  mode: TaskMode;
  targetLevel: DifficultyLevel;
  targetScore: number;
  path: ProgressionPath;
  /** Whether the content should be AI-authored per student (vs identical for everyone). */
  personalizeContent: boolean;
  /** Human-readable explanation shown to teacher and student ("Why am I getting this task?"). */
  rationale: string;
}

export interface ProgressionInput {
  mode: TaskMode;
  teacherLevel: DifficultyLevel;
  adaptiveDifficulty: boolean;
  /** Teacher may bound how far adaptation may move from their chosen level (in bands). */
  maxLevelShift?: number;
  skill: SkillState | null;
  skillName: string;
  /** Concept tags the student failed recently, from evaluation diagnostics. */
  recentFailedConcepts?: string[];
}

export const REMEDIATION_TRIGGER = { consecutiveFailures: 3, failThreshold: 0.5 } as const;
export const MASTERY_TRIGGER = { consecutiveHigh: 3, highThreshold: 0.95 } as const;

export function detectPath(skill: SkillState | null): ProgressionPath {
  if (!skill || skill.recent.length === 0) return 'standard';
  const r = skill.recent;
  const lastN = (n: number) => r.slice(-n);
  if (r.length >= REMEDIATION_TRIGGER.consecutiveFailures &&
      lastN(REMEDIATION_TRIGGER.consecutiveFailures).every((x) => x < REMEDIATION_TRIGGER.failThreshold)) {
    return 'remediation';
  }
  if (r.length >= MASTERY_TRIGGER.consecutiveHigh &&
      lastN(MASTERY_TRIGGER.consecutiveHigh).every((x) => x >= MASTERY_TRIGGER.highThreshold)) {
    return 'advanced';
  }
  return 'standard';
}

function shiftLevel(level: DifficultyLevel, by: number): DifficultyLevel {
  const i = Math.min(DIFFICULTY_LEVELS.length - 1, Math.max(0, DIFFICULTY_LEVELS.indexOf(level) + by));
  return DIFFICULTY_LEVELS[i]!;
}

function clampToTeacherBounds(level: DifficultyLevel, teacher: DifficultyLevel, maxShift: number): DifficultyLevel {
  const t = DIFFICULTY_LEVELS.indexOf(teacher);
  const i = DIFFICULTY_LEVELS.indexOf(level);
  return DIFFICULTY_LEVELS[Math.min(t + maxShift, Math.max(t - maxShift, i))]!;
}

export function decideProgression(input: ProgressionInput): ProgressionDecision {
  const { mode, teacherLevel, skillName } = input;
  const base = { mode, targetLevel: teacherLevel, targetScore: levelCentre(teacherLevel) };

  if (mode === 'STANDARDIZED') {
    return { ...base, path: 'standard', personalizeContent: false,
      rationale: `Standardised ${teacherLevel} ${skillName} task — everyone receives the same task so results are directly comparable.` };
  }
  if (mode === 'EQUIVALENT') {
    return { ...base, path: 'standard', personalizeContent: true,
      rationale: `A personalised ${teacherLevel} ${skillName} task that measures the same competency at comparable difficulty to your classmates' tasks.` };
  }

  // ADAPTIVE and PERSONALIZED consult the ability model.
  const path = detectPath(input.skill);
  const maxShift = input.maxLevelShift ?? 2;
  const rec = input.skill ? recommendedDifficulty(input.skill) : null;
  let level = input.adaptiveDifficulty && rec ? clampToTeacherBounds(rec.level, teacherLevel, maxShift) : teacherLevel;
  let rationale: string;

  if (path === 'remediation') {
    level = clampToTeacherBounds(shiftLevel(level, -1), teacherLevel, maxShift);
    const concepts = input.recentFailedConcepts?.length ? ` focusing on ${input.recentFailedConcepts.slice(0, 3).join(', ')}` : '';
    rationale = `Recent ${skillName} attempts were below the passing mark, so this is a focused practice task${concepts} at ${level} level. After practice you'll get a similar check and then return to ${teacherLevel}.`;
  } else if (path === 'advanced') {
    level = clampToTeacherBounds(shiftLevel(level, +1), teacherLevel, maxShift);
    rationale = `You've consistently scored 95%+ in ${skillName}, so this task moves to ${level} complexity (real-world/case style) instead of repeating the same level.`;
  } else if (rec && input.adaptiveDifficulty) {
    rationale = `Your current ${skillName} proficiency is ${input.skill!.proficiency.toFixed(0)}/100, so this task is set at ${level} — challenging but achievable.`;
  } else {
    rationale = `${teacherLevel} ${skillName} task set by your teacher.`;
  }

  const targetScore = level === teacherLevel || !rec ? levelCentre(level) : Math.min(levelCentre(level) + 9, Math.max(levelCentre(level) - 9, rec.score));
  return { mode, targetLevel: level, targetScore, path, personalizeContent: true, rationale };
}

/** Remediation loop steps; a Mission engine instance walks these for a student. */
export const REMEDIATION_STEPS = ['diagnose', 'remedial_activity', 'practice', 'similar_assessment', 'reassess', 'return_to_level'] as const;
export const ADVANCED_STEPS = ['confirm_mastery', 'harder_problem', 'real_world_case', 'project', 'peer_mentoring'] as const;

export { levelForScore };
