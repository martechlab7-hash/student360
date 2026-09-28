import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { GrowthRing, SkillRadar, TrendLine } from '../components/charts';
import { can, useSession } from '../session';
import { useApi } from '../useApi';

export function StudentProfile() {
  const { id } = useParams();
  const { me } = useSession();
  const p = useApi(`/students/${id}`);
  const g = useApi(`/students/${id}/growth`);
  const [iv, setIv] = useState({ kind: 'additional_practice', title: '', goal: '', skillId: '' });
  const [msg, setMsg] = useState<string | null>(null);
  if (p.error) return <p className="error">{p.error.message}</p>;
  if (!p.data || !g.data) return <p className="muted">Loading…</p>;
  const s = p.data.profile;
  const cur = g.data.current;
  return (
    <div className="stack">
      <section className="card hero">
        <GrowthRing value={cur?.overall ?? null} confidence={cur?.evidenceConfidence ?? null} />
        <div><h1 style={{ marginBottom: 2 }}>{s.full_name}</h1>
          <div className="small muted">{s.section} · {s.roll_no} · goals: {s.career_goals.join(', ') || '—'}</div>
          <div className="row" style={{ marginTop: 6 }}>{p.data.evidenceMix.map((m: any) => <span key={m.verification_level} className="pill">{m.verification_level.toLowerCase().replace('_', ' ')}: {m.n}</span>)}</div>
        </div>
      </section>
      <div className="grid two">
        <section className="card"><h2>Dimensions</h2><SkillRadar items={(cur?.dimensions ?? []).map((d: any) => ({ name: d.name, score: d.score }))} /></section>
        <section className="card"><h2>Growth trend</h2><TrendLine points={g.data.history} />
          <div className="tiny">Change over 28 days: {g.data.growth?.change ?? '–'} · velocity {g.data.growth?.velocity ?? '–'}/month</div></section>
      </div>
      <section className="card">
        <h2>Skill graph</h2>
        <div className="table-wrap"><table><thead><tr><th>Skill</th><th>Proficiency</th><th>Confidence</th><th>Evidence</th><th>Velocity</th><th>Recommended level</th></tr></thead>
          <tbody>{g.data.skills.map((k: any) => (
            <tr key={k.id}><td>{k.name}</td><td>{Math.round(k.proficiency)}{k.teacher_override && <span className="pill warn"> override {k.teacher_override.proficiency}</span>}</td>
              <td>{Math.round(k.confidence * 100)}%</td><td>{k.evidence_count}</td><td>{k.velocity}</td><td>{k.recommended_difficulty}</td></tr>))}</tbody></table></div>
      </section>
      {can(me, 'intervention:create') && (
        <section className="card stack">
          <h2>Start an intervention</h2>
          <p className="tiny">A baseline is captured now so the outcome can be measured when you evaluate it.</p>
          <div className="row">
            <select value={iv.kind} onChange={(e) => setIv({ ...iv, kind: e.target.value })} style={{ width: 'auto' }}>
              {['remedial_plan', 'mentoring', 'additional_practice', 'communication_mission', 'technical_mission', 'parent_communication', 'counselling_referral'].map((k) => <option key={k}>{k}</option>)}
            </select>
            <select value={iv.skillId} onChange={(e) => setIv({ ...iv, skillId: e.target.value })} style={{ width: 'auto' }}>
              <option value="">Overall growth</option>{g.data.skills.map((k: any) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
          </div>
          <input placeholder="Title" value={iv.title} onChange={(e) => setIv({ ...iv, title: e.target.value })} />
          <input placeholder="Goal (e.g. reach 60 in Aptitude in 4 weeks)" value={iv.goal} onChange={(e) => setIv({ ...iv, goal: e.target.value })} />
          {msg && <p className="small">{msg}</p>}
          <button className="btn" onClick={async () => {
            try { await api('/interventions', { method: 'POST', body: { studentId: id, kind: iv.kind, title: iv.title, goal: iv.goal, skillId: iv.skillId || undefined } }); setMsg('Intervention created.'); p.reload(); }
            catch (e) { setMsg(e instanceof ApiError ? e.message : 'Failed'); }
          }}>Create</button>
          {p.data.interventions.map((i: any) => <div key={i.id} className="small">{i.title} <span className="pill">{i.state}</span></div>)}
        </section>
      )}
      <section className="card">
        <h2>Recent evidence</h2>
        {p.data.evidence.map((e: any) => <div key={e.id} className="row small" style={{ padding: '4px 0' }}><span className="pill">{e.verification_level}</span>{e.title}<span className="spacer" /><span className="tiny">{new Date(e.occurred_at).toLocaleDateString()}</span></div>)}
      </section>
    </div>
  );
}
