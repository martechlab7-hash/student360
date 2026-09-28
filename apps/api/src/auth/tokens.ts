import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';
import { unauthorized } from '../lib/errors.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);

export interface AccessClaims {
  sub: string;       // user id
  tid: string;       // tenant id
  sid: string;       // auth session id
  kind: string;      // staff | student | guardian | external | platform
  typ: 'access';
}

export async function signAccessToken(c: Omit<AccessClaims, 'typ'>): Promise<string> {
  return new SignJWT({ tid: c.tid, sid: c.sid, kind: c.kind, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuer(config.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

export async function signMfaChallenge(userId: string, tenantId: string): Promise<string> {
  return new SignJWT({ tid: tenantId, typ: 'mfa' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer(config.JWT_ISSUER)
    .setIssuedAt().setExpirationTime('5m').sign(secret);
}

export async function verifyToken<T extends 'access' | 'mfa'>(token: string, typ: T) {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: config.JWT_ISSUER, algorithms: ['HS256'] });
    if (payload.typ !== typ || typeof payload.sub !== 'string' || typeof payload.tid !== 'string') throw new Error('bad token type');
    return payload as unknown as T extends 'access' ? AccessClaims : { sub: string; tid: string };
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}
