/**
 * Evidence trust model. Self-reported data is never treated as equivalent to system-verified data.
 */

export const VERIFICATION_LEVELS = ['VERIFIED', 'PARTIALLY_VERIFIED', 'SELF_REPORTED'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export const EVIDENCE_SOURCES = [
  'system', 'api', 'qr', 'attendance_system', 'biometric_system', 'teacher', 'certificate',
  'project', 'assessment', 'audio', 'video', 'document', 'self_report',
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** Multiplier applied to evidence when it feeds skill and growth calculations. */
export const VERIFICATION_WEIGHT: Readonly<Record<VerificationLevel, number>> = {
  VERIFIED: 1,
  PARTIALLY_VERIFIED: 0.6,
  SELF_REPORTED: 0.25,
};

/** The default verification level a source produces before any human review. */
export function defaultVerification(source: EvidenceSource): VerificationLevel {
  switch (source) {
    case 'system':
    case 'api':
    case 'attendance_system':
    case 'biometric_system':
    case 'assessment':
    case 'teacher':
      return 'VERIFIED';
    case 'qr':
    case 'certificate':
    case 'project':
    case 'audio':
    case 'video':
    case 'document':
      return 'PARTIALLY_VERIFIED';
    case 'self_report':
      return 'SELF_REPORTED';
  }
}

/**
 * Any change of verification level (upgrade or downgrade, e.g. a rejected certificate) must be
 * made by someone holding `evidence:approve`. Students can never change the trust of their own evidence.
 */
export function canTransition(from: VerificationLevel, to: VerificationLevel, actorIsVerifier: boolean): boolean {
  return from !== to && actorIsVerifier;
}

/**
 * Evidence Confidence (0..100) for a body of evidence: the trust-weighted share of evidence,
 * dampened when there is very little of it.
 */
export function evidenceConfidence(items: readonly { verification: VerificationLevel; weight?: number }[]): number {
  if (items.length === 0) return 0;
  let weighted = 0;
  let total = 0;
  for (const it of items) {
    const w = it.weight ?? 1;
    weighted += VERIFICATION_WEIGHT[it.verification] * w;
    total += w;
  }
  const trust = total === 0 ? 0 : weighted / total;
  const volume = 1 - Math.exp(-items.length / 8); // saturates around ~25 items
  return Math.round(trust * volume * 100);
}
