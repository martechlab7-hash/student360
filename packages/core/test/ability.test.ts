import { describe, expect, it } from 'vitest';
import { applySignal, INITIAL_SKILL_STATE, recommendedDifficulty, replay, type SkillSignal } from '../src/ability.js';

const sig = (performance: number, difficulty: number, day: number, verification: SkillSignal['verification'] = 'VERIFIED'): SkillSignal =>
  ({ performance, difficulty, verification, weight: 1, at: new Date(2026, 0, day) });

describe('ability model', () => {
  it('bootstraps from first demonstrated level', () => {
    const s = applySignal(INITIAL_SKILL_STATE, sig(0.8, 50, 1));
    expect(s.proficiency).toBeGreaterThan(50);
    expect(s.evidenceCount).toBe(1);
  });

  it('succeeding on hard tasks raises more than on easy ones', () => {
    const base = replay([sig(0.6, 50, 1), sig(0.6, 50, 2)]);
    const hard = applySignal(base, sig(1, 80, 3));
    const easy = applySignal(base, sig(1, 20, 3));
    expect(hard.proficiency - base.proficiency).toBeGreaterThan(easy.proficiency - base.proficiency);
  });

  it('self-reported evidence moves the needle much less than verified', () => {
    const base = replay([sig(0.6, 50, 1)]);
    const v = applySignal(base, sig(1, 70, 2, 'VERIFIED'));
    const s = applySignal(base, sig(1, 70, 2, 'SELF_REPORTED'));
    expect(v.proficiency - base.proficiency).toBeGreaterThan(2 * (s.proficiency - base.proficiency));
    expect(v.confidence).toBeGreaterThan(s.confidence);
  });

  it('recommends difficulty below proficiency (≈70% success target)', () => {
    const s = replay([sig(0.7, 60, 1), sig(0.7, 60, 5), sig(0.7, 60, 9)]);
    const rec = recommendedDifficulty(s);
    expect(rec.score).toBeLessThan(s.proficiency);
  });

  it('tracks positive velocity when improving', () => {
    const s = replay([sig(0.4, 40, 1), sig(0.6, 45, 8), sig(0.9, 55, 15), sig(0.95, 60, 22)]);
    expect(s.velocity).toBeGreaterThan(0);
    expect(s.recent).toHaveLength(4);
  });
});
