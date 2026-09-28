import { createContext, useContext } from 'react';

export interface Me {
  user: { id: string; email: string; full_name: string; kind: string; mfa_enabled: boolean };
  tenant: { id: string; slug: string; name: string };
  studentId: string | null;
  children: { id: string; full_name: string }[];
  roles: { key: string; scope_type: string; scope_id: string }[];
  permissions: string[];
}

export type Home = 'student' | 'teacher' | 'admin' | 'parent';

/** Which home to show. Pure presentation routing — the API enforces every permission. */
export function homeFor(me: Me): Home {
  if (me.studentId) return 'student';
  if (me.user.kind === 'guardian') return 'parent';
  if (me.roles.some((r) => r.scope_type === 'tenant' && (me.permissions.includes('*:*') || me.permissions.includes('analytics:view')))) return 'admin';
  return 'teacher';
}

export const SessionContext = createContext<{ me: Me; reload: () => Promise<void>; signOut: () => Promise<void> } | null>(null);
export function useSession() {
  const s = useContext(SessionContext);
  if (!s) throw new Error('no session');
  return s;
}
export const can = (me: Me, perm: string) => me.permissions.includes(perm) || me.permissions.includes(`${perm.split(':')[0]}:*`) || me.permissions.includes('*:*');
