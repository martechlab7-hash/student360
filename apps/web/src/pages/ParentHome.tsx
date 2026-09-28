import { useState } from 'react';
import { DimensionBars } from '../components/charts';
import { useSession } from '../session';
import { useApi } from '../useApi';

export function ParentHome() {
  const { me } = useSession();
  const [child, setChild] = useState(me.children[0]?.id ?? null);
  const { data, error } = useApi(child ? `/parent/children/${child}/summary` : null);
  if (!child) return <p className="muted">No linked students. Please contact the institution.</p>;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  if (data.restricted) return <p className="card">{data.message}</p>;
  const weeks = data.taskCompletion as { week: string; assigned: number; completed: number }[];
  return (
    <div className="stack">
      {me.children.length > 1 && <select value={child} onChange={(e) => setChild(e.target.value)}>{me.children.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select>}
      <section className="card">
        <div className="tiny">My child's progress</div>
        <h1>{data.student.name}</h1>
        <div className="row">
          <div><div className="tiny">Growth score</div><div className="hero-num">{data.growth?.score ?? '–'}</div></div>
          <div><div className="tiny">Change this month</div><div className={`hero-num delta ${(data.growth?.change ?? 0) >= 0 ? 'up' : 'down'}`}>{data.growth?.change != null ? `${data.growth.change > 0 ? '+' : ''}${data.growth.change}` : '–'}</div></div>
          <div><div className="tiny">Career readiness</div><div className="hero-num">{data.careerReadiness != null ? Math.round(data.careerReadiness) : '–'}</div></div>
        </div>
        <p className="tiny">Evidence confidence {data.growth?.evidenceConfidence ?? 0}/100 — how much of this is backed by verified records.</p>
      </section>
      <div className="grid two">
        <section className="card"><h2>Development areas</h2><DimensionBars items={data.growth?.areas ?? []} /></section>
        <section className="card"><h2>Weekly task completion</h2>
          <table><thead><tr><th>Week of</th><th>Completed</th></tr></thead>
            <tbody>{weeks.map((w) => <tr key={w.week}><td>{new Date(w.week).toLocaleDateString()}</td><td>{w.completed} / {w.assigned}</td></tr>)}</tbody></table></section>
      </div>
      <div className="grid two">
        <section className="card"><h2>Achievements & participation</h2>
          {[...data.verifiedAchievements, ...data.participation].length === 0 && <div className="empty">Nothing recorded yet.</div>}
          {data.verifiedAchievements.map((a: any, i: number) => <div key={i} className="small">✓ {a.title}</div>)}
          {data.participation.map((p: any, i: number) => <div key={`p${i}`} className="small">• {p.name} ({p.category})</div>)}</section>
        <section className="card"><h2>Recommended by the institution</h2>
          {data.recommendations.length === 0 && <div className="empty">No recommendations right now.</div>}
          {data.recommendations.map((r: any, i: number) => <div key={i} className="task"><div><b>{r.title}</b><div className="why">{r.rationale}</div></div></div>)}</section>
      </div>
    </div>
  );
}
