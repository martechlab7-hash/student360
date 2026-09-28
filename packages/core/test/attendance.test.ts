import { describe, expect, it } from 'vitest';
import { detectAnomalies, issueAttendanceToken, verifyAttendanceToken } from '../src/attendance.js';

describe('attendance tokens', () => {
  const secret = 'test-secret';
  it('verifies a fresh token and rejects expired/tampered/other-session tokens', () => {
    const now = 1_700_000_000_000;
    const { token } = issueAttendanceToken(secret, 'sess1', now);
    expect(verifyAttendanceToken(secret, 'sess1', token, now).valid).toBe(true);
    expect(verifyAttendanceToken(secret, 'sess1', token, now + 25_000).valid).toBe(true); // 1 window skew
    expect(verifyAttendanceToken(secret, 'sess1', token, now + 120_000).reason).toBe('expired');
    expect(verifyAttendanceToken(secret, 'sess2', token, now).reason).toBe('bad_signature');
    expect(verifyAttendanceToken(secret, 'sess1', token.slice(0, -2) + 'xx', now).valid).toBe(false);
  });
});

describe('anomaly detection', () => {
  const base = { registered: true, sessionStart: new Date('2026-01-01T10:00:00Z'), sessionEnd: new Date('2026-01-01T12:00:00Z'), graceMinutes: 15, overlappingSessionCheckIns: [] };
  it('clean check-in has no flags', () => {
    expect(detectAnomalies({ studentId: 's1', deviceHash: 'd1', ip: '1.1.1.1', at: new Date('2026-01-01T10:05:00Z') }, { ...base, priorCheckIns: [] }).flags).toEqual([]);
  });
  it('flags shared device, not-registered and out-of-window', () => {
    const r = detectAnomalies(
      { studentId: 's2', deviceHash: 'd1', ip: null, at: new Date('2026-01-01T13:00:00Z') },
      { ...base, registered: false, priorCheckIns: [{ studentId: 's1', deviceHash: 'd1', ip: null, at: new Date('2026-01-01T10:05:00Z') }] },
    );
    expect(r.flags).toEqual(expect.arrayContaining(['SHARED_DEVICE', 'NOT_REGISTERED', 'OUTSIDE_SESSION_WINDOW']));
  });
});
