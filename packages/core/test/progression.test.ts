import { describe, expect, it } from 'vitest';
import { decideProgression, detectPath } from '../src/progression.js';
import { INITIAL_SKILL_STATE, type SkillState } from '../src/ability.js';

const state = (recent: number[], proficiency = 60): SkillState => ({ ...INITIAL_SKILL_STATE, proficiency, confidence: 0.6, evidenceCount: recent.length, recent });

describe('progression', () => {
  it('standardized gives everyone the same task', () => {
    const d = decideProgression({ mode: 'STANDARDIZED', teacherLevel: 'intermediate', adaptiveDifficulty: true, skill: state([0.1, 0.1, 0.1]), skillName: 'English' });
    expect(d.personalizeContent).toBe(false);
    expect(d.targetLevel).toBe('intermediate');
  });

  it('equivalent keeps teacher level but personalises content', () => {
    const d = decideProgression({ mode: 'EQUIVALENT', teacherLevel: 'intermediate', adaptiveDifficulty: true, skill: state([1, 1, 1], 95), skillName: 'English' });
    expect(d.personalizeContent).toBe(true);
    expect(d.targetLevel).toBe('intermediate');
  });

  it('detects remediation after repeated failure and steps down with a reason', () => {
    expect(detectPath(state([0.3, 0.2, 0.4]))).toBe('remediation');
    const d = decideProgression({ mode: 'ADAPTIVE', teacherLevel: 'intermediate', adaptiveDifficulty: false, skill: state([0.3, 0.2, 0.4], 45), skillName: 'DSA', recentFailedConcepts: ['recursion'] });
    expect(d.path).toBe('remediation');
    expect(d.targetLevel).toBe('basic');
    expect(d.rationale).toContain('recursion');
  });

  it('advanced path after consistent mastery', () => {
    const d = decideProgression({ mode: 'PERSONALIZED', teacherLevel: 'intermediate', adaptiveDifficulty: false, skill: state([0.96, 0.97, 1], 70), skillName: 'Python' });
    expect(d.path).toBe('advanced');
    expect(d.targetLevel).toBe('advanced');
  });

  it('adaptation respects teacher bounds', () => {
    const d = decideProgression({ mode: 'ADAPTIVE', teacherLevel: 'intermediate', adaptiveDifficulty: true, maxLevelShift: 1, skill: state([0.8, 0.7, 0.9], 100), skillName: 'Python' });
    expect(['intermediate', 'advanced']).toContain(d.targetLevel);
  });
});
