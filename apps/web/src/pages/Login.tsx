import { useState, type FormEvent } from 'react';
import { api, ApiError, setToken } from '../api';

export function Login({ onLoggedIn }: { onLoggedIn: () => Promise<void> }) {
  const [tenant, setTenant] = useState(localStorageGet('s360.tenant') ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = mfaToken
        ? await api('/auth/mfa/verify', { method: 'POST', body: { mfaToken, code } })
        : await api('/auth/login', { method: 'POST', body: { tenant: tenant.trim().toLowerCase(), email, password } });
      if (r.mfaRequired) { setMfaToken(r.mfaToken); return; }
      setToken(r.accessToken);
      localStorageSet('s360.tenant', tenant.trim().toLowerCase());
      await onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <div className="brand" style={{ fontSize: '1.6rem', marginBottom: 4 }}>Student<span>360</span></div>
      <p className="muted" style={{ marginTop: 0 }}>Measure growth, not just activity.</p>
      <form className="card" onSubmit={submit}>
        {!mfaToken ? (
          <>
            <div className="field"><label htmlFor="tenant">Institution code</label>
              <input id="tenant" value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="demo-college" required autoComplete="organization" /></div>
            <div className="field"><label htmlFor="email">Email</label>
              <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></div>
            <div className="field"><label htmlFor="pw">Password</label>
              <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></div>
          </>
        ) : (
          <div className="field"><label htmlFor="code">6-digit code from your authenticator app</label>
            <input id="code" inputMode="numeric" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required /></div>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Signing in…' : mfaToken ? 'Verify' : 'Sign in'}</button>
      </form>
      <p className="tiny">Demo: institution <b>demo-college</b>, e.g. student1@demo.edu / teacher@demo.edu / admin@demo.edu / parent@demo.edu.</p>
    </div>
  );
}

// Only the non-sensitive institution code is remembered; storage may be unavailable.
function localStorageGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
