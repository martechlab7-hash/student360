import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useApi } from '../useApi';

const TYPES = ['text_response', 'audio', 'mcq', 'coding', 'reflection', 'assignment', 'presentation', 'interview', 'lab', 'file_upload'];
const LEVELS = ['beginner', 'basic', 'intermediate', 'advanced', 'expert'];
const MODES: [string, string][] = [
  ['EQUIVALENT', 'Equivalent — different task per student, same skill & difficulty (daily practice)'],
  ['ADAPTIVE', 'Adaptive — difficulty follows each student’s level, within your bounds'],
  ['PERSONALIZED', 'Personalised — targets each student’s gap; remediation / stretch paths'],
  ['STANDARDIZED', 'Standardised — identical for everyone (exams, baseline/final)'],
];

export function CreateTask() {
  const nav = useNavigate();
  const skills = useApi('/skills');
  const units = useApi('/org/units');
  const sections = (units.data?.items ?? []).filter((u: any) => u.type === 'section');
  const [f, setF] = useState<any>({ type: 'text_response', title: '', objective: '', instructions: '', difficultyLevel: 'intermediate', mode: 'EQUIVALENT',
    skillIds: [], sectionIds: [], dueAt: '', attempts: 1, teacherReview: false, assessmentKind: '', question: '', options: 'A\nB\nC\nD', answerIndex: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [ai, setAi] = useState({ request: '', count: 3 });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent, publish: boolean) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const content = f.type === 'mcq' ? { question: f.question, options: f.options.split('\n').map((s: string) => s.trim()).filter(Boolean), answerIndex: Number(f.answerIndex) } : {};
      const r = await api('/tasks/templates', { method: 'POST', body: {
        type: f.type, title: f.title, objective: f.objective, instructions: f.instructions || undefined, content, skillIds: f.skillIds,
        difficultyLevel: f.difficultyLevel, mode: f.mode, assessmentKind: f.assessmentKind || undefined,
        config: { attempts: Number(f.attempts), teacherReview: f.teacherReview }, target: { sectionIds: f.sectionIds, studentIds: [] },
        dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : undefined } });
      if (publish) await api(`/tasks/templates/${r.id}/publish`, { method: 'POST' });
      nav(`/templates/${r.id}`);
    } catch (e2) { setErr(e2 instanceof ApiError ? `${e2.message}${e2.details ? ` — ${JSON.stringify(e2.details)}` : ''}` : 'Failed'); } finally { setBusy(false); }
  };

  const draftWithAi = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await api('/ai/teacher/tasks', { method: 'POST', body: { request: ai.request, count: Number(ai.count), type: f.type, level: f.difficultyLevel,
        skillIds: f.skillIds, sectionIds: f.sectionIds } });
      nav(r.draftTemplateIds[0] ? `/templates/${r.draftTemplateIds[0]}` : '/');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); } finally { setBusy(false); }
  };

  const multi = (k: string, id: string) => set(k, f[k].includes(id) ? f[k].filter((x: string) => x !== id) : [...f[k], id]);

  return (
    <form className="stack" onSubmit={(e) => submit(e, true)}>
      <h1>New growth task</h1>
      <div className="grid two">
        <section className="card">
          <h2>Objective</h2>
          <div className="field"><label>Title</label><input value={f.title} onChange={(e) => set('title', e.target.value)} required /></div>
          <div className="field"><label>Objective (what competency this measures)</label><textarea value={f.objective} onChange={(e) => set('objective', e.target.value)} required style={{ minHeight: 80 }} /></div>
          <div className="field"><label>Instructions (optional)</label><textarea value={f.instructions} onChange={(e) => set('instructions', e.target.value)} style={{ minHeight: 60 }} /></div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>Type</label><select value={f.type} onChange={(e) => set('type', e.target.value)}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
            <div className="field" style={{ flex: 1 }}><label>Difficulty</label><select value={f.difficultyLevel} onChange={(e) => set('difficultyLevel', e.target.value)}>{LEVELS.map((t) => <option key={t}>{t}</option>)}</select></div>
          </div>
          {f.type === 'mcq' && (
            <>
              <div className="field"><label>Question</label><input value={f.question} onChange={(e) => set('question', e.target.value)} /></div>
              <div className="row"><div className="field" style={{ flex: 2 }}><label>Options (one per line)</label><textarea value={f.options} onChange={(e) => set('options', e.target.value)} style={{ minHeight: 90 }} /></div>
                <div className="field" style={{ flex: 1 }}><label>Correct option # (0-based)</label><input type="number" min={0} value={f.answerIndex} onChange={(e) => set('answerIndex', e.target.value)} /></div></div>
            </>
          )}
        </section>
        <section className="card">
          <h2>Mode & audience</h2>
          <div className="field"><label>Mode</label>
            {MODES.map(([m, d]) => <label key={m} className="row small" style={{ color: 'var(--text)', marginBottom: 6 }}>
              <input type="radio" style={{ width: 'auto' }} checked={f.mode === m} onChange={() => set('mode', m)} /> {d}</label>)}</div>
          <div className="field"><label>Assessment</label><select value={f.assessmentKind} onChange={(e) => set('assessmentKind', e.target.value)}>
            <option value="">Practice activity</option><option value="baseline">Baseline assessment</option><option value="formative">Formative check</option><option value="final">Final assessment</option></select></div>
          <div className="field"><label>Skills</label><div className="row" style={{ gap: 6 }}>{(skills.data?.items ?? []).map((s: any) => (
            <button type="button" key={s.id} className={`pill ${f.skillIds.includes(s.id) ? 'good' : ''}`} onClick={() => multi('skillIds', s.id)}>{s.name}</button>))}</div></div>
          <div className="field"><label>Sections</label><div className="row" style={{ gap: 6 }}>{sections.map((s: any) => (
            <button type="button" key={s.id} className={`pill ${f.sectionIds.includes(s.id) ? 'good' : ''}`} onClick={() => multi('sectionIds', s.id)}>{s.name}</button>))}</div></div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>Due</label><input type="datetime-local" value={f.dueAt} onChange={(e) => set('dueAt', e.target.value)} /></div>
            <div className="field" style={{ width: 110 }}><label>Attempts</label><input type="number" min={1} max={10} value={f.attempts} onChange={(e) => set('attempts', e.target.value)} /></div>
          </div>
          <label className="row small" style={{ color: 'var(--text)' }}><input type="checkbox" style={{ width: 'auto' }} checked={f.teacherReview} onChange={(e) => set('teacherReview', e.target.checked)} /> I will review every evaluation before it counts</label>
        </section>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="row"><button className="btn primary" disabled={busy}>Create & publish</button>
        <button type="button" className="btn" disabled={busy} onClick={(e) => submit(e as any, false)}>Save as draft</button></div>

      <section className="card stack">
        <h2>Or ask the AI assistant to draft tasks</h2>
        <p className="tiny">Uses the type, difficulty, skills and sections above. Drafts are never published until you review them.</p>
        <div className="row"><input placeholder="e.g. Create 5 intermediate DBMS activities on normalisation" value={ai.request} onChange={(e) => setAi({ ...ai, request: e.target.value })} style={{ flex: 1, width: 'auto' }} />
          <input type="number" min={1} max={10} value={ai.count} onChange={(e) => setAi({ ...ai, count: Number(e.target.value) })} style={{ width: 70 }} />
          <button type="button" className="btn" disabled={busy || !ai.request || !f.skillIds.length || !f.sectionIds.length} onClick={draftWithAi}>Draft</button></div>
      </section>
    </form>
  );
}
