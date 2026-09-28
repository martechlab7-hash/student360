/**
 * Dynamic attendance tokens and anomaly detection.
 *
 * The organiser screen displays a QR that encodes a short-lived HMAC token rotating every
 * `windowSeconds`. Tokens are bound to an event session, never static, and are verified
 * server-side. Anomalies are flagged for human review — never auto-accusations.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenOptions { windowSeconds: number; skewWindows: number }
export const DEFAULT_TOKEN_OPTIONS: TokenOptions = { windowSeconds: 20, skewWindows: 1 };

function sign(secret: string, sessionId: string, window: number): string {
  return createHmac('sha256', secret).update(`${sessionId}.${window}`).digest('base64url').slice(0, 22);
}

export function issueAttendanceToken(secret: string, sessionId: string, now = Date.now(), opts = DEFAULT_TOKEN_OPTIONS) {
  const window = Math.floor(now / 1000 / opts.windowSeconds);
  return {
    token: `${window}.${sign(secret, sessionId, window)}`,
    expiresAt: new Date((window + 1) * opts.windowSeconds * 1000),
  };
}

export function verifyAttendanceToken(
  secret: string, sessionId: string, token: string, now = Date.now(), opts = DEFAULT_TOKEN_OPTIONS,
): { valid: boolean; window?: number; reason?: string } {
  const [w, sig] = token.split('.');
  const window = Number(w);
  if (!sig || !Number.isInteger(window)) return { valid: false, reason: 'malformed' };
  const current = Math.floor(now / 1000 / opts.windowSeconds);
  if (window > current + 0 || window < current - opts.skewWindows) return { valid: false, reason: 'expired' };
  const expected = Buffer.from(sign(secret, sessionId, window));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { valid: false, reason: 'bad_signature' };
  return { valid: true, window };
}

export interface CheckInAttempt {
  studentId: string;
  deviceHash: string | null;
  ip: string | null;
  at: Date;
}

export interface CheckInContext {
  registered: boolean;
  sessionStart: Date;
  sessionEnd: Date;
  /** Grace before the start and after the end within which check-in is normal. */
  graceMinutes: number;
  /** Existing check-ins for this session (other students included). */
  priorCheckIns: readonly CheckInAttempt[];
  /** This student's check-ins in other sessions that overlap in time (for impossible-travel checks). */
  overlappingSessionCheckIns: readonly { sessionId: string; at: Date }[];
}

export type AnomalyCode =
  | 'DUPLICATE_CHECKIN'
  | 'NOT_REGISTERED'
  | 'OUTSIDE_SESSION_WINDOW'
  | 'SHARED_DEVICE'
  | 'OVERLAPPING_SESSION'
  | 'BURST_FROM_SAME_IP';

export interface AnomalyResult { flags: AnomalyCode[]; duplicate: boolean }

export function detectAnomalies(attempt: CheckInAttempt, ctx: CheckInContext): AnomalyResult {
  const flags: AnomalyCode[] = [];
  const duplicate = ctx.priorCheckIns.some((c) => c.studentId === attempt.studentId);
  if (duplicate) flags.push('DUPLICATE_CHECKIN');
  if (!ctx.registered) flags.push('NOT_REGISTERED');

  const grace = ctx.graceMinutes * 60_000;
  if (attempt.at.getTime() < ctx.sessionStart.getTime() - grace || attempt.at.getTime() > ctx.sessionEnd.getTime() + grace) {
    flags.push('OUTSIDE_SESSION_WINDOW');
  }
  if (attempt.deviceHash && ctx.priorCheckIns.some((c) => c.deviceHash === attempt.deviceHash && c.studentId !== attempt.studentId)) {
    flags.push('SHARED_DEVICE');
  }
  if (ctx.overlappingSessionCheckIns.length > 0) flags.push('OVERLAPPING_SESSION');
  if (attempt.ip) {
    const burst = ctx.priorCheckIns.filter(
      (c) => c.ip === attempt.ip && c.studentId !== attempt.studentId && Math.abs(c.at.getTime() - attempt.at.getTime()) < 10_000,
    ).length;
    if (burst >= 3) flags.push('BURST_FROM_SAME_IP');
  }
  return { flags, duplicate };
}
