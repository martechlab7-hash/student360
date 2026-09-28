import { hash, verify } from '@node-rs/argon2';

const COMMON = new Set(['password1234', '123456789012', 'qwertyuiop12', 'student36000', 'welcome12345', 'letmein12345']);

export function passwordPolicyErrors(password: string, email?: string): string[] {
  const errs: string[] = [];
  if (password.length < 12) errs.push('Password must be at least 12 characters');
  if (password.length > 256) errs.push('Password is too long');
  if (COMMON.has(password.toLowerCase())) errs.push('Password is too common');
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) errs.push('Password must not contain your email name');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) errs.push('Use at least three of: lowercase, uppercase, digits, symbols');
  return errs;
}

// Argon2id with OWASP-recommended parameters.
export const hashPassword = (p: string) => hash(p, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (h: string, p: string) => verify(h, p).catch(() => false);

/** A real hash verified when the user does not exist, keeping login timing uniform. */
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword('timing-equaliser-not-a-real-password'));
