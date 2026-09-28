/**
 * Growth Score engine.
 *
 *   Activities → Evidence → Skill Signals → Skill Scores → Development Dimensions → Overall
 *
 * Every weight lives in a tenant-owned, versioned ScoringConfig — nothing is hard-coded here
 * except the shape of the calculation. Each output carries an Evidence Confidence so a profile
 * built on self-reports never looks equivalent to one built on verified evidence.
 */

export interface DimensionConfig {
  key: string;
  weight: number;
  enabled: boolean;
  /**
   * Sensitive dimensions (e.g. well-being) are reported to authorised staff only and are
   * excluded from the overall score so they can never become a punitive number.
   */
  sensitive?: boolean;
}

export interface ScoringConfig {
  version: number;
  dimensions: DimensionConfig[];
  /**
   * Blend between demonstrated competency (skill proficiency) and engagement (participation,
   * task completion). Engagement is intentionally capped low: activity ≠ growth.
   */
  competencyWeight: number; // e.g. 0.85
  engagementWeight: number; // e.g. 0.15
  /** Skills with confidence below this contribute proportionally less. */
  minConfidenceForFullWeight: number; // e.g. 0.5
}

export const DEFAULT_SCORING_CONFIG: Omit<ScoringConfig, 'dimensions'> = {
  version: 1,
  competencyWeight: 0.85,
  engagementWeight: 0.15,
  minConfidenceForFullWeight: 0.5,
};

export interface SkillScoreInput {
  skillId: string;
  dimensionKey: string;
  proficiency: number; // 0..100
  confidence: number; // 0..1
  /** Relative weight of the skill within its dimension (default 1). */
  weight?: number;
}

export interface EngagementInput {
  dimensionKey: string;
  /** 0..1, e.g. completion rate of assigned tasks or attendance rate within the window. */
  rate: number;
}

export interface DimensionScore {
  key: string;
  score: number | null; // null when there is no evidence at all
  confidence: number; // 0..100
  skillCount: number;
}

export interface GrowthResult {
  configVersion: number;
  overall: number | null;
  evidenceConfidence: number; // 0..100
  dimensions: DimensionScore[];
}

export function computeGrowth(
  config: ScoringConfig,
  skills: readonly SkillScoreInput[],
  engagement: readonly EngagementInput[],
  evidenceConfidence: number,
): GrowthResult {
  const dims: DimensionScore[] = [];
  for (const d of config.dimensions) {
    if (!d.enabled) continue;
    const ds = skills.filter((s) => s.dimensionKey === d.key);
    const eng = engagement.find((e) => e.dimensionKey === d.key);

    let competency: number | null = null;
    let conf = 0;
    if (ds.length > 0) {
      let num = 0;
      let den = 0;
      let confSum = 0;
      for (const s of ds) {
        const confFactor = Math.min(1, s.confidence / config.minConfidenceForFullWeight);
        const w = (s.weight ?? 1) * Math.max(0.1, confFactor);
        num += s.proficiency * w;
        den += w;
        confSum += s.confidence * (s.weight ?? 1);
      }
      competency = den > 0 ? num / den : null;
      conf = confSum / ds.reduce((a, s) => a + (s.weight ?? 1), 0);
    }

    let score: number | null = null;
    if (competency !== null && eng) {
      score = competency * config.competencyWeight + eng.rate * 100 * config.engagementWeight;
    } else if (competency !== null) {
      score = competency;
    } else if (eng) {
      // Engagement alone can never produce a high dimension score.
      score = eng.rate * 100 * config.engagementWeight;
    }
    dims.push({ key: d.key, score: score === null ? null : round1(score), confidence: Math.round(conf * 100), skillCount: ds.length });
  }

  let num = 0;
  let den = 0;
  for (const d of config.dimensions) {
    if (!d.enabled || d.sensitive || d.weight <= 0) continue;
    const s = dims.find((x) => x.key === d.key);
    if (!s || s.score === null) continue;
    num += s.score * d.weight;
    den += d.weight;
  }
  return {
    configVersion: config.version,
    overall: den > 0 ? round1(num / den) : null,
    evidenceConfidence: Math.round(evidenceConfidence),
    dimensions: dims,
  };
}

export interface GrowthDelta {
  current: number | null;
  previous: number | null;
  change: number | null;
  /** Points per 30 days between the two snapshots. */
  velocity: number | null;
}

export function growthDelta(
  current: { overall: number | null; at: Date },
  previous: { overall: number | null; at: Date } | null,
): GrowthDelta {
  if (!previous || previous.overall === null || current.overall === null) {
    return { current: current.overall, previous: previous?.overall ?? null, change: null, velocity: null };
  }
  const change = round1(current.overall - previous.overall);
  const days = Math.max(1, (current.at.getTime() - previous.at.getTime()) / 86_400_000);
  return { current: current.overall, previous: previous.overall, change, velocity: round1((change / days) * 30) };
}

/** Baseline → retest measured improvement, used for outcome reporting. */
export function measuredImprovement(baseline: number, final: number): { baseline: number; final: number; improvement: number; relative: number | null } {
  return {
    baseline: round1(baseline),
    final: round1(final),
    improvement: round1(final - baseline),
    relative: baseline > 0 ? round1(((final - baseline) / baseline) * 100) : null,
  };
}

export function validateScoringConfig(c: ScoringConfig): string[] {
  const errs: string[] = [];
  if (Math.abs(c.competencyWeight + c.engagementWeight - 1) > 1e-6) errs.push('competencyWeight + engagementWeight must equal 1');
  if (c.engagementWeight > 0.4) errs.push('engagementWeight may not exceed 0.4 (activity is not growth)');
  const keys = new Set<string>();
  for (const d of c.dimensions) {
    if (keys.has(d.key)) errs.push(`duplicate dimension ${d.key}`);
    keys.add(d.key);
    if (d.weight < 0) errs.push(`dimension ${d.key} has negative weight`);
  }
  if (!c.dimensions.some((d) => d.enabled && !d.sensitive && d.weight > 0)) errs.push('at least one weighted, non-sensitive dimension must be enabled');
  return errs;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Initial configurable dimensions. Tenants may rename, disable, re-weight or add dimensions. */
export const DEFAULT_DIMENSIONS: { key: string; name: string; weight: number; sensitive?: boolean }[] = [
  { key: 'academics', name: 'Academics', weight: 3 },
  { key: 'technical', name: 'Technical Skills', weight: 2 },
  { key: 'coding', name: 'Coding', weight: 2 },
  { key: 'career', name: 'Career Readiness', weight: 2 },
  { key: 'communication', name: 'Communication', weight: 2 },
  { key: 'english', name: 'English', weight: 1 },
  { key: 'problem_solving', name: 'Problem Solving', weight: 2 },
  { key: 'critical_thinking', name: 'Critical Thinking', weight: 1 },
  { key: 'leadership', name: 'Leadership', weight: 1 },
  { key: 'teamwork', name: 'Teamwork', weight: 1 },
  { key: 'innovation', name: 'Innovation', weight: 1 },
  { key: 'research', name: 'Research', weight: 1 },
  { key: 'cultural', name: 'Cultural Participation', weight: 0.5 },
  { key: 'sports', name: 'Sports', weight: 0.5 },
  { key: 'social', name: 'Social Contribution', weight: 0.5 },
  { key: 'entrepreneurship', name: 'Entrepreneurship', weight: 0.5 },
  { key: 'professionalism', name: 'Professionalism', weight: 1 },
  { key: 'self_learning', name: 'Self Learning', weight: 1 },
  { key: 'digital', name: 'Digital Skills', weight: 1 },
  { key: 'wellbeing', name: 'Well-being', weight: 0, sensitive: true },
];
