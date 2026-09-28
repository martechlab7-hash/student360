/**
 * API client. The access token lives only in memory; the refresh token is an httpOnly,
 * SameSite=Strict cookie the browser sends to /api/v1/auth/refresh. No secrets in the bundle.
 */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export function setToken(t: string | null) { accessToken = t; }
export const hasToken = () => !!accessToken;

async function refresh(): Promise<boolean> {
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'x-s360-csrf': '1' }, credentials: 'same-origin' })
    .then(async (r) => { if (!r.ok) return false; accessToken = (await r.json()).accessToken; return true; })
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string } = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(`/api/v1${path}`, { method: opts.method ?? 'GET', headers, credentials: 'same-origin',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  if (res.status === 401 && retry && !path.startsWith('/auth/login') && (await refresh())) return api(path, opts, false);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? res.statusText, data?.error?.details);
  return data as T;
}

export const tryRefresh = refresh;
export const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => undefined); accessToken = null; };
