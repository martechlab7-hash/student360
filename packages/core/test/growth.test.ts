import { describe, expect, it } from 'vitest';
import { computeGrowth, DEFAULT_SCORING_CONFIG, growthDelta, measuredImprovement, validateScoringConfig, type ScoringConfig } from '../src/growth.js';
import { evidenceConfidence } from '../src/evidence.js';

const config: ScoringConfig = {
  ...DEFAULT_SCORING_CONFIG,
  dimensions: [
    { key: 'technical', weight: 2, enabled: true },
    { key: 'communication', weight: 1, enabled: true },
    { key: 'sports', weight: 1, enabled: false },
    { key: 'wellbeing', weight: 1, enabled: true, sensitive: true },
  ],
};

describe('growth engine', () => {
  it('weights dimensions per tenant config and excludes disabled/sensitive', () => {
    const r = computeGrowth(config, [
      { skillId: 'py', dimensionKey: 'technical', proficiency: 80, confidence: 1 },
      { skillId: 'sp', dimensionKey: 'communication', proficiency: 50, confidence: 1 },
      { skillId: 'wb', dimensionKey: 'wellbeing', proficiency: 10, confidence: 1 },
    ], [], 90);
    expect(r.overall).toBeCloseTo((80 * 2 + 50) / 3, 1);
    expect(r.dimensions.find((d) => d.key === 'sports')).toBeUndefined();
    expect(r.evidenceConfidence).toBe(90);
  });

  it('engagement alone cannot produce a high score', () => {
    const r = computeGrowth(config, [], [{ dimensionKey: 'technical', rate: 1 }], 10);
    expect(r.dimensions.find((d) => d.key === 'technical')!.score).toBeLessThanOrEqual(15);
  });

  it('computes delta and velocity', () => {
    const d = growthDelta({ overall: 70, at: new Date(2026, 1, 1) }, { overall: 64, at: new Date(2026, 0, 2) });
    expect(d.change).toBe(6);
    expect(d.velocity).toBeCloseTo(6, 0);
  });

  it('measured improvement baseline → final', () => {
    expect(measuredImprovement(48, 71)).toMatchObject({ improvement: 23 });
  });

  it('validates configs', () => {
    expect(validateScoringConfig(config)).toEqual([]);
    expect(validateScoringConfig({ ...config, engagementWeight: 0.6, competencyWeight: 0.4 })).not.toEqual([]);
  });

  it('evidence confidence separates verified from self-reported profiles', () => {
    const verified = evidenceConfidence(Array.from({ length: 20 }, () => ({ verification: 'VERIFIED' as const })));
    const self = evidenceConfidence(Array.from({ length: 20 }, () => ({ verification: 'SELF_REPORTED' as const })));
    expect(verified).toBeGreaterThan(80);
    expect(self).toBeLessThan(30);
  });
});
