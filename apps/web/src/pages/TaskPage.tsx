import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useSession } from '../session';
import { useApi } from '../useApi';

export function TaskPage() {
  const { id } = useParams();
  const { me } = useSession();
  const { data: a, error, reload } = useApi(`/tasks/assignments/${id}`);
  const [answer, setAnswer] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // One idempotency key per attempt: a retried request over a flaky network never double-submits.
  const idemKey = useMemo(() => crypto.randomUUID(), [a?.attempts_used]);

  const evaluating = a?.submissions?.some((s: any) => s.status === 'submitted' || s.status === 'evaluating');
  useEffect(() => {
    if (!evaluating) return;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [evaluating, reload]);

  if (error) return <p className="error">{error.message}</p>;
  if (!a) return <p className="muted">Loading…</p>;
  const c = a.content ?? {};
  const isMine = !!me.studentId && a.student_id === me.studentId;
  const attemptsLeft = (a.config?.attempts ?? 1) - a.attempts_used;
  const canSubmit = isMine && attemptsLeft > 0 && ['assigned', 'in_progress', 'evaluated'].includes(a.status);

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      await api(`/tasks/assignments/${id}/submissions`, { method: 'POST', body: answer, idempotencyKey: idemKey });
      setMsg('Submitted — evaluating now.');
      setAnswer({});
      reload();
    } catch (e) { setMsg(e instanceof ApiError ? `${e.message}` : 'Could not submit'); } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <Link to="/" className="small">← Back</Link>
      <section className="card stack">
        <div className="row"><span className="pill">{a.type.replace('_', ' ')}</span><span className="pill">{a.difficulty_level}</span>
          {a.due_at && <span className="tiny">due {new Date(a.due_at).toLocaleString()}</span>}</div>
        <h1>{c.title}</h1>
        <p style={{ whiteSpace: 'pre-wrap' }}>{c.prompt}</p>
        {c.question && a.type !== 'mcq' && <blockquote className="card" style={{ margin: 0, background: 'var(--surface-2)' }}>{c.question}</blockquote>}
        {c.hints?.length > 0 && <details><summary>Hints</summary><ul>{c.hints.map((h: string) => <li key={h}>{h}</li>)}</ul></details>}
        <p className="tiny">Why this task: {a.rationale}</p>
      </section>

      {canSubmit && (
        <section className="card stack">
          <h2>Your response <span className="tiny">{attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} left</span></h2>
          <AnswerInput type={a.type} content={c} value={answer} onChange={setAnswer} />
          {msg && <p className="small">{msg}</p>}
          <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Submitting…' : 'Submit'}</button>
        </section>
      )}

      {a.submissions?.length > 0 && (
        <section className="card stack">
          <h2>Feedback</h2>
          {a.submissions.map((s: any) => (
            <div key={s.id} className="stack">
              <div className="row"><b>Attempt {s.attempt_no}</b>
                {s.score != null ? <span className="pill good">{Math.round(s.score)}%</span> : <span className="pill">{s.status === 'needs_review' ? 'with your teacher' : 'evaluating…'}</span>}
                {s.evaluator_type && <span className="tiny">evaluated by {s.evaluator_type === 'ai' ? 'AI (reviewable by your teacher)' : s.evaluator_type}</span>}
              </div>
              {s.output?.overallFeedback && <p>{s.output.overallFeedback}</p>}
              {s.output?.feedback && <p>{s.output.feedback}</p>}
              {Array.isArray(s.criteria) && s.criteria.length > 0 && (
                <div className="table-wrap"><table><thead><tr><th>Criterion</th><th>Score</th><th>Feedback</th></tr></thead>
                  <tbody>{s.criteria.map((cr: any) => <tr key={cr.name}><td>{cr.name}</td><td>{cr.score}/{cr.maxScore}</td><td className="small">{cr.feedback ?? ''}</td></tr>)}</tbody></table></div>
              )}
              {s.output?.improvements?.length > 0 && <div className="small"><b>Next time:</b> {s.output.improvements.join('; ')}</div>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function AnswerInput({ type, content, value, onChange }: { type: string; content: any; value: any; onChange: (v: any) => void }) {
  if (type === 'mcq') {
    return (
      <div className="stack">
        <p style={{ fontWeight: 600 }}>{content.question}</p>
        {(content.options ?? []).map((o: string, i: number) => (
          <label key={i} className="task" style={{ cursor: 'pointer', color: 'var(--text)' }}>
            <input type="radio" name="mcq" style={{ width: 'auto' }} checked={value.answerIndex === i} onChange={() => onChange({ answerIndex: i })} /> {o}
          </label>
        ))}
      </div>
    );
  }
  if (type === 'coding' || type === 'sql') {
    return (
      <>
        {content.problem && <p>{content.problem}</p>}
        <textarea style={{ fontFamily: 'ui-monospace, monospace', minHeight: 220 }} defaultValue={content.starterCode}
          onChange={(e) => onChange({ language: type === 'sql' ? 'sql' : content.language ?? 'python', code: e.target.value })} />
        <p className="tiny">Code runs in an isolated sandbox, never on our servers.</p>
      </>
    );
  }
  if (type === 'audio' || type === 'video') return <SpeechInput value={value} onChange={onChange} />;
  if (['file_upload', 'image', 'presentation'].includes(type)) {
    return <input placeholder="Link to your file (e.g. institution drive URL)" onChange={(e) => onChange({ fileRef: e.target.value })} />;
  }
  return <textarea placeholder="Write your response…" value={value.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} />;
}

/** Captures speech with the browser's speech recognition where available; otherwise type the transcript. */
function SpeechInput({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const Rec = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  const rec = useRef<any>(null);
  const started = useRef<number>(0);
  const [recording, setRecording] = useState(false);
  const start = () => {
    const r = new Rec();
    r.lang = 'en-IN'; r.continuous = true; r.interimResults = false;
    let text = value.transcript ?? '';
    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += `${e.results[i][0].transcript} `;
      onChange({ transcript: text.trim(), durationSeconds: Math.round((Date.now() - started.current) / 1000) });
    };
    r.onend = () => setRecording(false);
    rec.current = r; started.current = Date.now(); r.start(); setRecording(true);
  };
  return (
    <div className="stack">
      {Rec ? (
        <button className="btn" onClick={() => (recording ? rec.current?.stop() : start())}>{recording ? '■ Stop speaking' : '🎙 Start speaking'}</button>
      ) : <p className="tiny">Speech capture is not supported in this browser — type what you said.</p>}
      <textarea placeholder="Transcript of your answer" value={value.transcript ?? ''} onChange={(e) => onChange({ ...value, transcript: e.target.value })} />
      <p className="tiny">Pronunciation is only scored when audio analysis is enabled; transcripts are scored on fluency, structure, grammar and relevance.</p>
    </div>
  );
}
