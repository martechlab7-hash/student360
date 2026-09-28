import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../useApi';

export function TemplateDetail() {
  const { id } = useParams();
  const t = useApi(`/tasks/templates/${id}`);
  const a = useApi(`/tasks/templates/${id}/assignments`);
  if (!t.data) return <p className="muted">Loading…</p>;
  const d = t.data;
  return (
    <div className="stack">
      <section className="card stack">
        <div className="row"><span className="pill">{d.mode}</span><span className="pill">{d.status}</span><span className="pill">{d.difficulty_level}</span>
          {d.source === 'ai' && <span className="pill warn">AI draft — review before publishing</span>}</div>
        <h1>{d.title}</h1>
        <p>{d.objective}</p>
        {d.instructions && <p className="small muted">{d.instructions}</p>}
        {d.rubric && <details><summary>Rubric (v{d.rubric_version})</summary><table><tbody>{d.rubric.map((r: any) => <tr key={r.name}><td>{r.name}</td><td>{r.maxPoints} pts</td><td className="small">{r.description}</td></tr>)}</tbody></table></details>}
        {d.status !== 'published' && d.status !== 'archived' && (
          <button className="btn primary" onClick={async () => { await api(`/tasks/templates/${id}/publish`, { method: 'POST' }); t.reload(); setTimeout(a.reload, 1500); }}>Approve & publish</button>
        )}
      </section>
      <section className="card">
        <h2>Per-student variants <span className="tiny">{a.data?.items?.length ?? 0} students</span></h2>
        <p className="tiny">Same objective; AI personalises content where the mode allows. Variants are accepted only when their difficulty profile matches the target.</p>
        <div className="table-wrap"><table><thead><tr><th>Student</th><th>Task given</th><th>Level / path</th><th>Status</th><th>Score</th></tr></thead>
          <tbody>{(a.data?.items ?? []).map((x: any) => (
            <tr key={x.id}><td>{x.full_name}</td>
              <td className="small">{x.prompt}{x.generation?.fallback && <div className="tiny">used teacher content (AI variant not validated)</div>}</td>
              <td className="small">{x.difficulty_level}{x.path !== 'standard' ? ` · ${x.path}` : ''}</td><td><span className="pill">{x.status}</span></td>
              <td>{x.score != null ? Math.round(x.score) : '–'}</td></tr>))}</tbody></table></div>
      </section>
    </div>
  );
}
