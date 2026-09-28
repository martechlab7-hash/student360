import { describe, expect, it } from 'vitest';
import { compositeDifficulty, isEquivalent, levelForScore, profileForLevel } from '../src/difficulty.js';

describe('difficulty', () => {
  it('level profiles map back to their level', () => {
    for (const l of ['beginner', 'basic', 'intermediate', 'advanced', 'expert'] as const) {
      expect(levelForScore(compositeDifficulty(profileForLevel(l)))).toBe(l);
    }
  });

  it('equivalence detects drift', () => {
    const a = profileForLevel('intermediate');
    expect(isEquivalent(a, { ...a, ambiguity: a.ambiguity + 0.1 }).ok).toBe(true);
    const r = isEquivalent(a, { ...a, reasoningSteps: 0.95, problemComplexity: 0.95 });
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});
