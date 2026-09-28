import { useState } from 'react';
import { api, ApiError } from '../api';
import { useApi } from '../useApi';

export function Review() {
  const { data, reload } = useApi('/evaluations/pending');
  const evidence = useApi('/evidence/review');
  const flagged = useApi('/attendance/flagged');
  return (
    <div className="stack">
      <h1>Review queue</h1>
      <section className="stack">
        <h2>Submissions ({data?.items?.length ?? 0})</h2>
        {(data?.items ?? []).length === 0 && <div className="empty">Nothing waiting. 🎉</div>}
        {(data?.items ?? []).map((s: any) => <ReviewItem key={s.submission_id} s={s} onDone={reload} />)}
      </section>
      <section className="card">
        <h2>Evidence to verify ({evidence.data?.items?.length ?? 0})</h2>
        {(evidence.data?.items ?? []).map((e: any) => (
          <div key={e.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ flex: 1 }}><b>{e.full_name}</b> — {e.title} <span className="pill">{e.verification_level}</span>
              {e.data?.externalUrl && <a href={e.data.externalUrl} target="_blank" rel="noreferrer noopener" className="small"> link</a>}</div>
            <button className="btn sm" onClick={async () => { await api(`/evidence/${e.id}/verify`, { method: 'POST', body: { level: 'VERIFIED' } }); evidence.reload(); }}>Verify</button>
            <button className="btn sm ghost" onClick={async () => { await api(`/evidence/${e.id}/verify`, { method: 'POST', body: { level: 'PARTIALLY_VERIFIED', note: 'Supporting evidence only' } }); evidence.reload(); }}>Partial</button>
          </div>
        ))}
      </section>
      {flagged.data && (
        <section className="card">
          <h2>Flagged attendance ({flagged.data.items.length})</h2>
          <p className="tiny">Flags are signals for review, not accusations.</p>
          {flagged.data.items.map((a: any) => (
            <div key={a.id} className="row" style={{ padding: '6px 0' }}>
              <div style={{ flex: 1 }}><b>{a.full_name}</b> · {a.event} · {a.flags.map((f: string) => <span key={f} className="pill warn" style={{ marginLeft: 4 }}>{f.toLowerCase().replace(/_/g, ' ')}</span>)}</div>
              <button className="btn sm" onClick={async () => { await api(`/attendance/${a.id}/review`, { method: 'POST', body: { decision: 'accepted' } }); flagged.reload(); }}>Accept</button>
              <button className="btn sm ghost" onClick={async () => { await api(`/attendance/${a.id}/review`, { method: 'POST', body: { decision: 'rejected' } }); flagged.reload(); }}>Reject</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function ReviewItem({ s, onDone }: { s: any; onDone: () => void }) {
  const [score, setScore] = useState<string>(s.suggested_score != null ? String(Math.round(s.suggested_score)) : '');
  const [feedback, setFeedback] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const text = s.payload?.text ?? s.payload?.transcript ?? s.payload?.code ?? JSON.stringify(s.payload);
  const save = async () => {
    try {
      await api(`/submissions/${s.submission_id}/evaluate`, { method: 'POST', body: { score: Number(score), feedback: feedback || undefined,
        reason: reason || (s.evaluator_type === 'ai' ? 'Teacher review of AI suggestion' : undefined) } });
      onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  };
  return (
    <div className="card stack">
      <div className="row"><b>{s.full_name}</b><span className="pill">{s.type}</span><span>{s.title}</span><span className="spacer" />
        <span className="tiny">{new Date(s.submitted_at).toLocaleString()}</span></div>
      {s.prompt && <p className="small muted">{s.prompt}</p>}
      <blockquote style={{ margin: 0, whiteSpace: 'pre-wrap' }} className="card">{text}</blockquote>
      {s.ai_output?.criteria && (
        <details open><summary>AI suggestion: {Math.round(s.suggested_score)}% · confidence {Math.round((s.ai_output.confidence ?? 0) * 100)}%</summary>
          <table><tbody>{s.ai_output.criteria.map((c: any) => <tr key={c.name}><td>{c.name}</td><td>{c.score}/{c.maxScore}</td><td className="small">{c.feedback}</td></tr>)}</tbody></table>
        </details>
      )}
      {s.ai_output?.reason && <p className="tiny">Routed to you: {s.ai_output.reason}</p>}
      <div className="row">
        <input type="number" min={0} max={100} value={score} onChange={(e) => setScore(e.target.value)} style={{ width: 90 }} placeholder="Score" />
        <input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Feedback to student" style={{ flex: 1, width: 'auto' }} />
      </div>
      {s.evaluator_type === 'ai' && <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason if you change the AI score (audited)" />}
      {err && <p className="error">{err}</p>}
      <button className="btn primary" disabled={score === ''} onClick={save}>Confirm evaluation</button>
    </div>
  );
}
