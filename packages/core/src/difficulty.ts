/**
 * Difficulty is represented internally as a vector of measurable characteristics.
 * Teacher-facing levels (Beginner … Expert) are just named bands over the composite value.
 */

export const DIFFICULTY_LEVELS = ['beginner', 'basic', 'intermediate', 'advanced', 'expert'] as const;
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];

export interface DifficultyProfile {
  /** Each characteristic is on 0..1. */
  conceptComplexity: number;
  reasoningSteps: number;
  prerequisiteKnowledge: number;
  ambiguity: number;
  timePressure: number;
  problemComplexity: number;
  cognitiveLoad: number;
}

export const DIFFICULTY_WEIGHTS: Readonly<Record<keyof DifficultyProfile, number>> = {
  conceptComplexity: 0.2,
  reasoningSteps: 0.2,
  prerequisiteKnowledge: 0.15,
  ambiguity: 0.1,
  timePressure: 0.1,
  problemComplexity: 0.15,
  cognitiveLoad: 0.1,
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Composite difficulty on a 0..100 scale — the same scale as skill proficiency. */
export function compositeDifficulty(p: DifficultyProfile): number {
  let total = 0;
  for (const k of Object.keys(DIFFICULTY_WEIGHTS) as (keyof DifficultyProfile)[]) {
    total += clamp01(p[k]) * DIFFICULTY_WEIGHTS[k];
  }
  return Math.round(total * 1000) / 10;
}

/** Band boundaries on the 0..100 scale (lower bound inclusive). */
const BANDS: readonly [DifficultyLevel, number][] = [
  ['beginner', 0], ['basic', 20], ['intermediate', 40], ['advanced', 60], ['expert', 80],
];

export function levelForScore(score: number): DifficultyLevel {
  let level: DifficultyLevel = 'beginner';
  for (const [l, lo] of BANDS) if (score >= lo) level = l;
  return level;
}

/** Centre of a band, used when a teacher only specifies a level. */
export function levelCentre(level: DifficultyLevel): number {
  const i = DIFFICULTY_LEVELS.indexOf(level);
  return i * 20 + 10;
}

/** A uniform profile whose composite equals the centre of the given level. */
export function profileForLevel(level: DifficultyLevel): DifficultyProfile {
  const v = levelCentre(level) / 100;
  return {
    conceptComplexity: v, reasoningSteps: v, prerequisiteKnowledge: v, ambiguity: v,
    timePressure: v, problemComplexity: v, cognitiveLoad: v,
  };
}

/**
 * Equivalence check used to validate AI-generated variants in EQUIVALENT mode:
 * the composite must be within `tolerance` points and no single characteristic may drift
 * by more than `maxAxisDrift`.
 */
export function isEquivalent(
  a: DifficultyProfile,
  b: DifficultyProfile,
  tolerance = 5,
  maxAxisDrift = 0.2,
): { ok: boolean; delta: number; reasons: string[] } {
  const delta = Math.abs(compositeDifficulty(a) - compositeDifficulty(b));
  const reasons: string[] = [];
  if (delta > tolerance) reasons.push(`composite difficulty differs by ${delta.toFixed(1)} (> ${tolerance})`);
  for (const k of Object.keys(DIFFICULTY_WEIGHTS) as (keyof DifficultyProfile)[]) {
    const d = Math.abs(clamp01(a[k]) - clamp01(b[k]));
    if (d > maxAxisDrift) reasons.push(`${k} drifts by ${d.toFixed(2)} (> ${maxAxisDrift})`);
  }
  return { ok: reasons.length === 0, delta, reasons };
}

export function parseDifficultyProfile(input: unknown): DifficultyProfile | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const out: Partial<DifficultyProfile> = {};
  for (const k of Object.keys(DIFFICULTY_WEIGHTS) as (keyof DifficultyProfile)[]) {
    const v = o[k];
    if (typeof v !== 'number' || Number.isNaN(v)) return null;
    out[k] = clamp01(v);
  }
  return out as DifficultyProfile;
}
