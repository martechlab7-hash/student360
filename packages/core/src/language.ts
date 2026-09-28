/**
 * Guardrail for teacher-facing insights: observations must be evidence-based and neutral.
 * Labels such as "lazy" or "weak student" are rejected and replaced with factual phrasing.
 */

const BANNED = [
  'lazy', 'weak student', 'problematic', 'stupid', 'dumb', 'hopeless', 'careless', 'bad student',
  'troublemaker', 'slow learner', 'unmotivated', 'depressed', 'anxious', 'mentally',
];

export function findJudgementalTerms(text: string): string[] {
  const t = text.toLowerCase();
  return BANNED.filter((w) => t.includes(w));
}

export function isNeutral(text: string): boolean {
  return findJudgementalTerms(text).length === 0;
}

/** Builds a neutral, factual trend observation from numbers. */
export function describeTrend(metric: string, values: readonly number[], unit: string, periodLabel: string): string | null {
  if (values.length < 2) return null;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const diff = last - first;
  if (Math.abs(diff) < 1e-9) return `${metric} has been stable at ${fmt(last)}${unit} over ${values.length} ${periodLabel}.`;
  const monotonic = values.every((v, i) => i === 0 || (diff < 0 ? v <= values[i - 1]! : v >= values[i - 1]!));
  const dir = diff < 0 ? 'declined' : 'increased';
  const shape = monotonic ? `has ${dir} steadily` : `has ${dir} overall`;
  return `${metric} ${shape} over ${values.length} ${periodLabel} (${fmt(first)}${unit} → ${fmt(last)}${unit}).`;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
