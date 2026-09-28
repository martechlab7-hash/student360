import { useState } from 'react';
import { api, ApiError } from '../api';
import { DimensionBars } from '../components/charts';
import { useApi } from '../useApi';

export function AdminHome() {
  const { data, error } = useApi('/dashboard/admin');
  const improvement = useApi('/growth/improvement');
  const usage = useApi('/ai/usage');
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const h = data.institutionHealth ?? {};
  return (
    <div className="stack">
      <h1>Institutional Outcomes</h1>
      <div className="grid three">
        <div className="card"><div className="tiny">Average growth score</div><div className="hero-num">{h.avg_growth ?? '–'}</div>
          <div className={`small delta ${(h.avg_change_28d ?? 0) >= 0 ? 'up' : 'down'}`}>{h.avg_change_28d != null ? `${h.avg_change_28d > 0 ? '+' : ''}${h.avg_change_28d} over 28 days` : ''}</div></div>
        <div className="card"><div className="tiny">Evidence confidence</div><div className="hero-num">{h.avg_evidence_confidence ?? '–'}</div><div className="tiny">share of growth backed by verified evidence</div></div>
        <div className="card"><div className="tiny">Active students (7d)</div><div className="hero-num">{data.engagement?.active_last_7d ?? 0}<span className="tiny"> / {h.active_students}</span></div>
          <div className="tiny">{data.engagement?.submissions_last_7d ?? 0} submissions</div></div>
      </div>
      <div className="grid two">
        <section className="card"><h2>Departments</h2>
          <DimensionBars items={data.departments.map((d: any) => ({ name: `${d.name} (${d.students})`, score: d.avg_growth }))} /></section>
        <section className="card"><h2>Measured improvement <span className="tiny">baseline → final</span></h2>
          {(improvement.data?.items ?? []).length === 0 ? <div className="empty">Run a standardized baseline and final assessment to measure improvement.</div> : (
            <table><thead><tr><th>Skill</th><th>Students</th><th>Baseline</th><th>Final</th><th>Δ</th></tr></thead>
              <tbody>{improvement.data.items.map((r: any) => <tr key={r.skill}><td>{r.skill}</td><td>{r.students}</td><td>{r.avg_baseline}</td><td>{r.avg_final}</td>
                <td className={`delta ${r.avg_improvement >= 0 ? 'up' : 'down'}`}>{r.avg_improvement > 0 ? '+' : ''}{r.avg_improvement}</td></tr>)}</tbody></table>)}
          <p className="tiny">{improvement.data?.note}</p></section>
      </div>
      <div className="grid two">
        <section className="card"><h2>Interventions</h2>
          <div className="small">{data.interventions?.total ?? 0} total · {data.interventions?.evaluated ?? 0} evaluated · avg measured change {data.interventions?.avg_improvement ?? '–'}</div></section>
        <section className="card"><h2>AI usage (30 days)</h2>
          <div className="small">{data.ai?.calls_30d ?? 0} calls · ${data.ai?.cost_30d ?? 0} · {data.ai?.failures_30d ?? 0} failures</div>
          <table><thead><tr><th>Feature</th><th>Model</th><th>Calls</th><th>Avg latency</th></tr></thead>
            <tbody>{(usage.data?.byFeature ?? []).map((u: any) => <tr key={u.feature + u.model}><td>{u.feature}</td><td className="tiny">{u.model}</td><td>{u.calls}</td><td>{u.avg_latency_ms} ms</td></tr>)}</tbody></table></section>
      </div>
      <Dimensions />
      <p className="tiny">{data.note}</p>
    </div>
  );
}

/** Development dimensions are configuration, not code: enable, disable and weight them per institution. */
function Dimensions() {
  const { data, reload } = useApi('/config/dimensions');
  const [rows, setRows] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const items = rows ?? data?.items ?? [];
  if (!items.length || items[0].weight === undefined) return null;
  const upd = (i: number, k: string, v: unknown) => setRows(items.map((r: any, j: number) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <section className="card">
      <h2>Development dimensions</h2>
      <div className="table-wrap"><table><thead><tr><th>Dimension</th><th>Enabled</th><th>Weight</th><th>Sensitive</th></tr></thead>
        <tbody>{items.map((d: any, i: number) => (
          <tr key={d.key}><td>{d.name}</td>
            <td><input type="checkbox" style={{ width: 'auto' }} checked={d.enabled} onChange={(e) => upd(i, 'enabled', e.target.checked)} /></td>
            <td><input type="number" step="0.5" min={0} value={d.weight} onChange={(e) => upd(i, 'weight', Number(e.target.value))} style={{ width: 80 }} /></td>
            <td className="tiny">{d.sensitive ? 'excluded from score' : ''}</td></tr>))}</tbody></table></div>
      {msg && <p className="small">{msg}</p>}
      <button className="btn primary" disabled={!rows} onClick={async () => {
        try {
          const r = await api('/config/dimensions', { method: 'PUT', body: { dimensions: items.map((d: any) => ({ key: d.key, name: d.name, weight: Number(d.weight), enabled: d.enabled, sensitive: d.sensitive })) } });
          setMsg(r.note); setRows(null); reload();
        } catch (e) { setMsg(e instanceof ApiError ? `${e.message}: ${JSON.stringify(e.details)}` : 'Failed'); }
      }}>Save weights</button>
    </section>
  );
}
