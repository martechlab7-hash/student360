import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';

interface Msg { role: 'user' | 'assistant'; content: string; actions?: { kind: string; title: string; reason: string; refId?: string }[] }

const STARTERS = ['What should I do today?', 'What should I improve?', 'Why am I getting these tasks?', 'Help me prepare for an interview.'];

export function Mentor() {
  const [mode, setMode] = useState<'mentor' | 'interview'>('mentor');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [conv, setConv] = useState<string | undefined>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState('Software Engineer');
  const [kind, setKind] = useState('technical');

  const send = async (message: string) => {
    if (!message.trim()) return;
    setBusy(true);
    setMsgs((m) => [...m, { role: 'user', content: message }]);
    setText('');
    try {
      if (mode === 'mentor') {
        const r = await api('/ai/mentor', { method: 'POST', body: { message, conversationId: conv } });
        setConv(r.conversationId);
        setMsgs((m) => [...m, { role: 'assistant', content: r.reply, actions: r.actions }]);
      } else {
        const r = await api('/ai/interview', { method: 'POST', body: { kind, role, answer: message, conversationId: conv } });
        setConv(r.conversationId);
        setMsgs((m) => [...m, { role: 'assistant', content: r.done ? `${r.question}\n\n(Interview complete.)` : r.question }]);
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: e instanceof ApiError ? e.message : 'Something went wrong.' }]);
    } finally { setBusy(false); }
  };

  const startInterview = async () => {
    setMode('interview'); setMsgs([]); setConv(undefined); setBusy(true);
    try {
      const r = await api('/ai/interview', { method: 'POST', body: { kind, role } });
      setConv(r.conversationId);
      setMsgs([{ role: 'assistant', content: r.question }]);
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="row">
          <h1 style={{ margin: 0 }}>{mode === 'mentor' ? 'AI Mentor' : 'Mock Interview'}</h1><span className="spacer" />
          {mode === 'interview' && <button className="btn sm" onClick={() => { setMode('mentor'); setMsgs([]); setConv(undefined); }}>Back to mentor</button>}
        </div>
        <p className="tiny">AI guidance based on your profile, tasks and results. It suggests actions and explains why; your teachers can see and adjust your plan.</p>
        {mode === 'mentor' && (
          <details><summary>Practise a mock interview</summary>
            <div className="row" style={{ marginTop: 8 }}>
              <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>
                <option value="technical">Technical</option><option value="hr">HR</option><option value="behavioral">Behavioural</option><option value="role_specific">Role-specific</option>
              </select>
              <input value={role} onChange={(e) => setRole(e.target.value)} style={{ flex: 1, width: 'auto' }} />
              <button className="btn" onClick={startInterview}>Start</button>
            </div>
          </details>
        )}
      </section>
      <section className="card stack">
        <div className="chat">
          {msgs.length === 0 && mode === 'mentor' && (
            <div className="row">{STARTERS.map((s) => <button key={s} className="btn sm" onClick={() => send(s)}>{s}</button>)}</div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.content}
              {m.actions && m.actions.length > 0 && (
                <div className="stack" style={{ marginTop: 8 }}>
                  {m.actions.map((a, j) => (
                    <div key={j} className="task" style={{ background: 'var(--surface)' }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{a.kind === 'start_task' && a.refId ? <Link to={`/tasks/${a.refId}`}>{a.title} →</Link> : a.title}</div>
                        <div className="why">{a.reason}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="bubble assistant muted">Thinking…</div>}
        </div>
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); void send(text); }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === 'mentor' ? 'Ask your mentor…' : 'Your answer…'} style={{ flex: 1, width: 'auto' }} />
          <button className="btn primary" disabled={busy}>Send</button>
        </form>
      </section>
    </div>
  );
}
