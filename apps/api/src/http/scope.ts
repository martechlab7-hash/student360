import { can } from '@s360/core';
import type { AuthContext } from '../auth/principal.js';
import { studentScopeFilter } from '../auth/principal.js';
import { many, one, type Db } from '../db/pool.js';
import { notFound } from '../lib/errors.js';

/** Student ids visible to the caller for a permission, or null when access is tenant-wide. */
export async function visibleStudentIds(db: Db, auth: AuthContext, permission: string): Promise<string[] | null> {
  if (can(auth.principal, permission)) return null;
  const f = studentScopeFilter(auth.principal, permission, 1);
  if (!f) return null;
  const rows = await many<{ id: string }>(db, `SELECT s.id FROM students s JOIN org_units sec ON sec.id = s.section_id WHERE ${f.sql}`, f.params);
  return rows.map((r) => r.id);
}

/** The student profile id of the logged-in student user. */
export async function myStudentId(db: Db, auth: AuthContext): Promise<string> {
  const s = await one<{ id: string }>(db, `SELECT id FROM students WHERE user_id = $1`, [auth.userId]);
  if (!s) throw notFound('Student profile');
  return s.id;
}
