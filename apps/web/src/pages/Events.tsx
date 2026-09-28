import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { can, useSession } from '../session';
import { useApi } from '../useApi';

function deviceId() {
  try {
    let d = localStorage.getItem('s360.device');
    if (!d) { d = crypto.randomUUID(); localStorage.setItem('s360.device', d); }
    return d;
  } catch { return undefined; }
}

export function Events() {
  const { me } = useSession();
  const { data, reload } = useApi('/events');
  const [params, setParams] = useSearchParams();
  const [msg, setMsg] = useState<string | null>(null);
  const isStudent = !!me.studentId;
  const organiser = can(me, 'attendance:create') && me.user.kind === 'staff';

  // Scanning the organiser's QR opens /events?s=<session>&t=<token> → check in automatically.
  useEffect(() => {
    const s = params.get('s'), t = params.get('t');
    if (!isStudent || !s || !t) return;
    api('/attendance/check-in', { method: 'POST', body: { sessionId: s, token: t, deviceId: deviceId() } })
      .then((r) => setMsg(r.message)).catch((e) => setMsg(e instanceof ApiError ? e.message : 'Check-in failed'))
      .finally(() => setParams({}, { replace: true }));
  }, [params, isStudent, setParams]);

  return (
    <div className="stack">
      <h1>Events</h1>
      {msg && <div className="card">{msg}</div>}
      {(data?.items ?? []).map((e: any) => (
        <section className="card stack" key={e.id}>
          <div className="row"><span className="pill">{e.category}</span><b>{e.name}</b><span className="spacer" />
            <span className="tiny">{e.organizer}{e.venue ? ` · ${e.venue}` : ''}</span></div>
          <div className="small muted">{e.registered} registered{e.capacity ? ` / ${e.capacity}` : ''}</div>
          {(e.sessions ?? []).map((s: any) => (
            <div className="row" key={s.id}>
              <span className="small">{new Date(s.startsAt).toLocaleString()} – {new Date(s.endsAt).toLocaleTimeString()}</span><span className="spacer" />
              {organiser && <Link className="btn sm" to={`/events/sessions/${s.id}/qr`}>Show check-in QR</Link>}
            </div>
          ))}
          {isStudent && (e.is_registered ? <span className="pill good">Registered</span> : (
            <button className="btn sm" onClick={async () => {
              try { const r = await api(`/events/${e.id}/register`, { method: 'POST' }); setMsg(`Registration: ${r.status}`); reload(); }
              catch (err) { setMsg(err instanceof ApiError ? err.message : 'Failed'); }
            }}>Register</button>
          ))}
        </section>
      ))}
      {data?.items?.length === 0 && <div className="empty">No events yet.</div>}
    </div>
  );
}

/** Organiser screen: a QR that rotates every few seconds. Screenshots expire within ~40 s. */
export function OrganiserQr() {
  const { id } = useParams();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [exp, setExp] = useState<string>('');
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api(`/events/sessions/${id}/token`);
        const url = `${window.location.origin}/events?s=${id}&t=${encodeURIComponent(r.token)}`;
        if (alive && canvas.current) await QRCode.toCanvas(canvas.current, url, { width: 360, margin: 1 });
        setExp(new Date(r.expiresAt).toLocaleTimeString()); setErr(null);
      } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not load token'); }
    };
    void tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);
  return (
    <div className="card qr">
      <h1>Scan to check in</h1>
      {err ? <p className="error">{err}</p> : <canvas ref={canvas} />}
      <p className="tiny">Code rotates automatically · current code valid until {exp}. Unusual check-ins are flagged for your review, not rejected.</p>
    </div>
  );
}
