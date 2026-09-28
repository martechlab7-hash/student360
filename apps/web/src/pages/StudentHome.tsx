import { Link } from 'react-router-dom';
import { GrowthRing, SkillRadar, TrendLine } from '../components/charts';
import { useApi } from '../useApi';
import { api } from '../api';

export function StudentHome() {
  const dash = useApi('/dashboard/student');
  const today = useApi('/tasks/today');
  if (dash.loading && !dash.data) return <p className="muted">Loading your growth…</p>;
  if (dash.error) return <p className="error">{dash.error.message}</p>;
  const g = dash.data.growth;
  const cur = g.current;
  const change = g.growth?.change;
  const dims = (cur?.dimensions ?? []).map((d: any) => ({ name: d.name, score: d.score }));
  const items = today.data?.items ?? [];
  const open = items.filter((t: any) => t.status === 'assigned' || t.status === 'in_progress');

  return (
    <div className="stack">
      <section className="card">
        <div className="hero">
          <GrowthRing value={cur?.overall ?? null} confidence={cur?.evidenceConfidence ?? null} />
          <div>
            <div className="tiny">Today's Growth</div>
            <h1 style={{ margin: '2px 0' }}>{open.length ? `${open.length} task${open.length > 1 ? 's' : ''} to go` : 'All done for today'}</h1>
            <div className="small muted">
              {change != null && <span className={`delta ${change >= 0 ? 'up' : 'down'}`}>{change >= 0 ? '▲' : '▼'} {Math.abs(change)} this month · </span>}
              Evidence confidence {cur?.evidenceConfidence ?? 0}/100 · 🔥 {today.data?.streakDays ?? 0}-day streak
            </div>
          </div>
        </div>
      </section>

      <div className="grid two">
        <section className="card">
          <h2>Today's tasks <span className="tiny">{today.data?.completedToday ?? 0} done</span></h2>
          <div className="stack">
            {items.length === 0 && <div className="empty">No tasks yet — check back soon.</div>}
            {items.map((t: any) => {
              const done = t.status === 'submitted' || t.status === 'evaluated';
              return (
                <Link to={`/tasks/${t.id}`} key={t.id} className={`task ${done ? 'done' : ''}`} style={{ color: 'inherit' }}>
                  <div className="check">{done ? '✓' : ''}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{t.content?.title ?? 'Task'}</div>
                    <div className="row" style={{ gap: 6, marginTop: 4 }}>
                      {t.dimension && <span className="pill">{t.dimension}</span>}
                      <span className="pill">{t.difficulty_level}</span>
                      {t.path !== 'standard' && <span className="pill warn">{t.path === 'remediation' ? 'focused practice' : 'stretch'}</span>}
                      {t.score != null && <span className="pill good">{Math.round(t.score)}%</span>}
                      {t.status === 'submitted' && <span className="pill">evaluating…</span>}
                    </div>
                    <div className="why">Why: {t.rationale}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        <section className="card">
          <h2>Development areas</h2>
          <SkillRadar items={dims} />
        </section>
      </div>

      <div className="grid two">
        <section className="card">
          <h2>Growth this month</h2>
          <TrendLine points={g.history} />
        </section>
        <section className="card">
          <h2>What to do next <Link to="/mentor" className="small">Ask your mentor →</Link></h2>
          <div className="stack">
            {dash.data.nextActions.filter((a: any) => a.type === 'recommendation').length === 0 && <div className="empty">Nothing extra — focus on today's tasks.</div>}
            {dash.data.nextActions.filter((a: any) => a.type === 'recommendation').map((a: any) => (
              <div key={a.id} className="task">
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{a.title}</div>
                  <div className="why">{a.why}</div>
                </div>
                <button className="btn sm ghost" title="Dismiss" onClick={async () => { await api(`/recommendations/${a.id}`, { method: 'PATCH', body: { status: 'dismissed' } }); dash.reload(); }}>✕</button>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid two">
        <section className="card">
          <h2>Skills</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Skill</th><th>Level</th><th>Trend</th><th>Evidence</th></tr></thead>
            <tbody>{g.skills.slice(0, 12).map((s: any) => (
              <tr key={s.id}><td>{s.name}</td><td>{Math.round(s.teacher_override?.proficiency ?? s.proficiency)}<span className="tiny"> /100</span></td>
                <td className={s.velocity > 0 ? 'delta up' : s.velocity < 0 ? 'delta down' : ''}>{s.velocity > 0 ? '▲' : s.velocity < 0 ? '▼' : '–'} {Math.abs(s.velocity)}</td>
                <td className="tiny">{s.evidence_count} · conf {Math.round(s.confidence * 100)}%</td></tr>))}</tbody>
          </table></div>
        </section>
        <section className="card">
          <h2>Upcoming events <Link to="/events" className="small">All →</Link></h2>
          {dash.data.upcomingEvents.length === 0 && <div className="empty">No upcoming events.</div>}
          {dash.data.upcomingEvents.map((e: any) => (
            <div key={e.id} className="row" style={{ padding: '6px 0' }}><span className="pill">{e.category}</span><span>{e.name}</span>
              <span className="spacer" /><span className="tiny">{new Date(e.starts_at).toLocaleDateString()}</span></div>
          ))}
        </section>
      </div>
    </div>
  );
}
