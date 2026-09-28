import { z } from 'zod';

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

/** Keyset cursor over (created_at, id) — stable under concurrent inserts. */
export function encodeCursor(createdAt: Date | string, id: string) {
  return Buffer.from(JSON.stringify([new Date(createdAt).toISOString(), id])).toString('base64url');
}

export function decodeCursor(c?: string): [string, string] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString());
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch { /* fallthrough */ }
  return null;
}

export function page<T extends { created_at: Date | string; id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null };
}
