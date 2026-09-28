import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useSession } from '../session';
import { useApi } from '../useApi';

const LEVEL: Record<string, [string, string]> = { VERIFIED: ['good', 'Verified'], PARTIALLY_VERIFIED: ['warn', 'Partially verified'], SELF_REPORTED: ['', 'Self-reported'] };

export function Evidence() {
  const { me } = useSession();
  const { data, reload } = useApi(me.studentId ? `/students/${me.studentId}/evidence` : null);
  const [f, setF] = useState({ title: '', activityType: 'certification', description: '', externalUrl: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/evidence', { method: 'POST', body: { ...f, externalUrl: f.externalUrl || undefined, description: f.description || undefined } });
      setMsg('Added as self-reported. A teacher can verify it.'); setF({ ...f, title: '', description: '', externalUrl: '' }); reload();
    } catch (err) { setMsg(err instanceof ApiError ? err.message : 'Failed'); }
  };
  return (
    <div className="grid two">
      <section className="card">
        <h2>My evidence portfolio</h2>
        <p className="tiny">Everything that shapes your growth score, and how it was verified.</p>
        <div className="table-wrap"><table><thead><tr><th>Activity</th><th>Source</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>{(data?.items ?? []).map((e: any) => {
            const [cls, label] = LEVEL[e.verification_level] ?? ['', e.verification_level];
            return <tr key={e.id}><td>{e.title}</td><td className="tiny">{e.source}</td><td><span className={`pill ${cls}`}>{label}</span></td>
              <td className="tiny">{new Date(e.occurred_at).toLocaleDateString()}</td></tr>;
          })}</tbody></table></div>
      </section>
      <form className="card" onSubmit={add}>
        <h2>Add an external achievement</h2>
        <div className="field"><label>Title</label><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} /></div>
        <div className="field"><label>Type</label><select value={f.activityType} onChange={(e) => setF({ ...f, activityType: e.target.value })}>
          {['certification', 'competition', 'volunteering', 'leadership', 'sports', 'cultural', 'research', 'internship', 'course', 'other'].map((t) => <option key={t}>{t}</option>)}</select></div>
        <div className="field"><label>Link (certificate, repo…)</label><input type="url" value={f.externalUrl} onChange={(e) => setF({ ...f, externalUrl: e.target.value })} /></div>
        <div className="field"><label>Details</label><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        {msg && <p className="small">{msg}</p>}
        <button className="btn primary">Add</button>
      </form>
    </div>
  );
}
