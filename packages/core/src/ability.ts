/**
 * Student Ability Model.
 *
 * Each (student, skill) pair has a proficiency on 0..100 plus a confidence (0..1) that grows
 * with the amount and trustworthiness of evidence. Updates follow an Elo/IRT-style rule:
 * performing well on a hard task moves proficiency more than performing well on an easy one.
 * The update is deterministic and explainable — no opaque model decides a student's level.
 */

import { levelForScore, type DifficultyLevel } from './difficulty.js';
import { VERIFICATION_WEIGHT, type VerificationLevel } from './evidence.js';

export interface SkillState {
  proficiency: number; // 0..100
  confidence: number; // 0..1
  evidenceCount: number;
  velocity: number; // points per 30 days, exponentially smoothed
  lastAssessedAt: Date | null;
  /** Rolling window of recent normalised scores (0..1), newest last. */
  recent: number[];
}

export interface SkillSignal {
  /** Normalised performance 0..1 (e.g. evaluation score / max score). */
  performance: number;
  /** Composite task difficulty 0..100. */
  difficulty: number;
  verification: VerificationLevel;
  /** Relative importance, e.g. standardised assessment = 2, daily practice = 1, participation = 0.2. */
  weight: number;
  at: Date;
}

export const INITIAL_SKILL_STATE: SkillState = {
  proficiency: 0,
  confidence: 0,
  evidenceCount: 0,
  velocity: 0,
  lastAssessedAt: null,
  recent: [],
};

const RECENT_WINDOW = 10;
const LOGISTIC_SCALE = 15; // points of (ability - difficulty) per logit

/** Expected performance of a student with `ability` on a task of `difficulty` (both 0..100). */
export function expectedPerformance(ability: number, difficulty: number): number {
  return 1 / (1 + Math.exp(-(ability - difficulty) / LOGISTIC_SCALE));
}

export function applySignal(state: SkillState, signal: SkillSignal): SkillState {
  const trust = VERIFICATION_WEIGHT[signal.verification];
  const perf = Math.min(1, Math.max(0, signal.performance));

  // Bootstrap: with no prior evidence, anchor to the demonstrated level rather than 0.
  const prior = state.evidenceCount === 0 ? signal.difficulty : state.proficiency;
  const expected = expectedPerformance(prior, signal.difficulty);

  // Learning rate shrinks as confidence grows so established profiles are stable.
  const k = 24 * (1 - 0.6 * state.confidence) * signal.weight * trust;
  const proficiency = clamp(prior + k * (perf - expected), 0, 100);

  const confidenceGain = 0.12 * trust * Math.min(signal.weight, 2);
  const confidence = clamp(state.confidence + (1 - state.confidence) * confidenceGain, 0, 1);

  let velocity = state.velocity;
  if (state.lastAssessedAt && state.evidenceCount > 0) {
    const days = Math.max(1, (signal.at.getTime() - state.lastAssessedAt.getTime()) / 86_400_000);
    const instant = ((proficiency - state.proficiency) / days) * 30;
    velocity = 0.7 * state.velocity + 0.3 * instant;
  }

  return {
    proficiency: round1(proficiency),
    confidence: round3(confidence),
    evidenceCount: state.evidenceCount + 1,
    velocity: round1(velocity),
    lastAssessedAt: signal.at,
    recent: [...state.recent, perf].slice(-RECENT_WINDOW),
  };
}

/** Replays a full signal history (sorted by time) — used by the background recalculation job. */
export function replay(signals: readonly SkillSignal[], from: SkillState = INITIAL_SKILL_STATE): SkillState {
  return [...signals].sort((a, b) => a.at.getTime() - b.at.getTime()).reduce(applySignal, from);
}

/**
 * Recommended difficulty targets a ~70% expected success rate ("desirable difficulty"):
 * hard enough to stretch, easy enough to avoid discouragement.
 */
export function recommendedDifficulty(state: SkillState, targetSuccess = 0.7): { score: number; level: DifficultyLevel } {
  if (state.evidenceCount === 0) return { score: 30, level: levelForScore(30) };
  const logit = Math.log(targetSuccess / (1 - targetSuccess));
  const score = clamp(state.proficiency - LOGISTIC_SCALE * logit, 0, 100);
  return { score: round1(score), level: levelForScore(score) };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
