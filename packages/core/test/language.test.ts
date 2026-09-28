import { describe, expect, it } from 'vitest';
import { describeTrend, isNeutral } from '../src/language.js';

describe('neutral language', () => {
  it('rejects labels', () => {
    expect(isNeutral('This student is lazy')).toBe(false);
    expect(isNeutral('Assignment completion declined over four weeks')).toBe(true);
  });
  it('describes trends factually', () => {
    expect(describeTrend('Assignment completion', [90, 80, 70, 55], '%', 'weeks')).toBe('Assignment completion has declined steadily over 4 weeks (90% → 55%).');
  });
});
