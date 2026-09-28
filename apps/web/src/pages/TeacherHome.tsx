import { Link } from 'react-router-dom';
import { useApi } from '../useApi';

export function TeacherHome() {
  const { data, error } = useApi('/dashboard/teacher');
  const students = useApi('/students?limit=100');
  const templates = useApi('/tasks/templates?limit=10');
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const ws = data.weekSummary;
  return (
    <div className="stack">
      <div className="row"><h1 style={{ margin: 0 }}>My Students</h1><span className="spacer" />
        <Link className="btn primary" to="/tasks/new">+ New task</Link></div>

      <div className="grid three">
        <div className="card"><div className="tiny">Needs your review</div><div className="hero-num">{data.pendingEvaluations.length}</div>
          <Link to="/review" className="small">Open review queue →</Link></div>
        <div className="card"><div className="tiny">Task completion (7 days)</div>
          <div className="hero-num">{ws?.assigned ? Math.round((ws.completed / ws.assigned) * 100) : 0}%</div>
          <div className="tiny">{ws?.completed ?? 0} of {ws?.assigned ?? 0}</div></div>
        <div className="card"><div className="tiny">Attention signals</div><div className="hero-num">{data.insights.length}</div>
          <div className="tiny">evidence-based observations below</div></div>
      </div>

      <div className="grid two">
        <section className="card">
          <h2>Actions required</h2>
          {data.insights.length === 0 && <div className="empty">No unusual patterns detected.</div>}
          {data.insights.map((i: any, k: number) => (
            <div key={k} className="task">
              <div><div style={{ fontWeight: 600 }}><Link to={`/students/${i.studentId}`}>{i.studentName}</Link></div>
                <div className="why">{i.message}</div></div>
            </div>
          ))}
          <p className="tiny">Observations are factual trends, not judgements. Consider a conversation before acting.</p>
        </section>
        <section className="card">
          <h2>Class skill gaps</h2>
          <div className="table-wrap"><table><thead><tr><th>Skill</th><th>Class avg</th><th>Below 50</th></tr></thead>
            <tbody>{data.skillGaps.map((g: any) => <tr key={g.skill}><td>{g.skill}</td><td>{g.avg_proficiency}</td><td>{g.below_50} / {g.students}</td></tr>)}</tbody></table></div>
        </section>
      </div>

      <div className="grid two">
        <section className="card">
          <h2>Students</h2>
          <div className="table-wrap"><table><thead><tr><th>Name</th><th>Section</th><th>Growth</th><th>Confidence</th></tr></thead>
            <tbody>{(students.data?.items ?? []).map((s: any) => (
              <tr key={s.id}><td><Link to={`/students/${s.id}`}>{s.full_name}</Link></td><td>{s.section}</td>
                <td>{s.growth_score ?? '–'}</td><td className="tiny">{s.evidence_confidence ?? '–'}</td></tr>))}</tbody></table></div>
        </section>
        <section className="card">
          <h2>Recent tasks</h2>
          {(templates.data?.items ?? []).map((t: any) => (
            <Link key={t.id} to={`/templates/${t.id}`} className="task" style={{ color: 'inherit', marginBottom: 8 }}>
              <div style={{ flex: 1 }}><div style={{ fontWeight: 600 }}>{t.title}</div>
                <div className="row" style={{ gap: 6 }}><span className="pill">{t.mode}</span><span className="pill">{t.status}</span>
                  {t.source === 'ai' && <span className="pill warn">AI draft</span>}<span className="tiny">{t.completed}/{t.assigned} done</span></div></div>
            </Link>
          ))}
          {data.interventions.length > 0 && <><h3 style={{ marginTop: 12 }}>Open interventions</h3>
            {data.interventions.map((i: any) => <div key={i.id} className="small">{i.full_name}: {i.title} <span className="pill">{i.state}</span></div>)}</>}
        </section>
      </div>
    </div>
  );
}
