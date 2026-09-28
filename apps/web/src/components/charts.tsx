/**
 * Single-series charts (one hue: --series-1). Text uses ink tokens; every chart has a hover
 * tooltip and a table view so values never depend on colour or pointer alone.
 */
import { useEffect, useRef, useState } from 'react';

/** Measures the container so SVG text stays at real pixel sizes on every screen width. */
function useWidth(fallback = 560) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function GrowthRing({ value, confidence, size = 108 }: { value: number | null; confidence: number | null; size?: number }) {
  const r = size / 2 - 7;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Growth score ${value ?? 'not yet available'} out of 100`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={8} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--series-1)" strokeWidth={8} strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="48%" textAnchor="middle" fontSize={size * 0.26} fontWeight={750} fill="var(--text)">{value == null ? '–' : Math.round(value)}</text>
      <text x="50%" y="68%" textAnchor="middle" fontSize={10} fill="var(--text-2)">{confidence == null ? '' : `confidence ${confidence}`}</text>
    </svg>
  );
}

export function TrendLine({ points, height = 120 }: { points: { date: string; overall: number | null }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, w] = useWidth();
  const pts = points.filter((p) => p.overall != null) as { date: string; overall: number }[];
  if (pts.length < 2) return <div className="empty">Your trend appears after a few days of activity.</div>;
  const pad = { l: 30, r: 8, t: 8, b: 20 };
  const ys = pts.map((p) => p.overall);
  const lo = Math.max(0, Math.floor((Math.min(...ys) - 5) / 10) * 10), hi = Math.min(100, Math.ceil((Math.max(...ys) + 5) / 10) * 10);
  const x = (i: number) => pad.l + (i / (pts.length - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (height - pad.t - pad.b);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.overall).toFixed(1)}`).join('');
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <svg viewBox={`0 0 ${w} ${height}`} width={w} height={height} style={{ display: 'block' }} role="img" aria-label="Growth score over time"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = ((e.clientX - box.left) / box.width) * w;
          setHover(Math.max(0, Math.min(pts.length - 1, Math.round(((rel - pad.l) / (w - pad.l - pad.r)) * (pts.length - 1)))));
        }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--text-3)">{Math.round(t)}</text>
          </g>
        ))}
        <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
        <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1]!.overall)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} stroke="var(--text-3)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(pts[hover]!.overall)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
        <text x={pad.l} y={height - 4} fontSize={10} fill="var(--text-3)">{pts[0]!.date.slice(0, 10)}</text>
        <text x={w - pad.r} y={height - 4} fontSize={10} fill="var(--text-3)" textAnchor="end">{pts[pts.length - 1]!.date.slice(0, 10)}</text>
      </svg>
      {hover != null && (
        <div className="viz-tip" style={{ left: `${(x(hover) / w) * 100}%`, top: `${(y(pts[hover]!.overall) / height) * 100}%` }}>
          {pts[hover]!.date.slice(0, 10)} · {pts[hover]!.overall}
        </div>
      )}
      <details><summary>View as table</summary>
        <table><thead><tr><th>Date</th><th>Growth score</th></tr></thead>
          <tbody>{pts.map((p) => <tr key={p.date}><td>{p.date.slice(0, 10)}</td><td>{p.overall}</td></tr>)}</tbody></table>
      </details>
    </div>
  );
}

/** Radar over development dimensions (single series). Falls back to bars below 3 axes. */
export function SkillRadar({ items, size = 280 }: { items: { name: string; score: number | null }[]; size?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const data = items.filter((i) => i.score != null) as { name: string; score: number }[];
  if (data.length < 3) return <DimensionBars items={items} />;
  const cx = size / 2, cy = size / 2, R = size / 2 - 36;
  const pt = (i: number, v: number) => {
    const a = (Math.PI * 2 * i) / data.length - Math.PI / 2;
    return [cx + Math.cos(a) * R * (v / 100), cy + Math.sin(a) * R * (v / 100)] as const;
  };
  const poly = data.map((d, i) => pt(i, d.score).join(',')).join(' ');
  return (
    <div>
      <svg viewBox={`-60 0 ${size + 120} ${size}`} width="100%" style={{ maxWidth: size + 120, display: 'block', margin: '0 auto' }} role="img" aria-label="Development dimensions radar">
        {[25, 50, 75, 100].map((r) => (
          <polygon key={r} points={data.map((_, i) => pt(i, r).join(',')).join(' ')} fill="none" stroke="var(--grid)" />
        ))}
        <polygon points={poly} fill="color-mix(in srgb, var(--series-1) 22%, transparent)" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
        {data.map((d, i) => {
          const [x, y] = pt(i, d.score);
          const [lx, ly] = pt(i, 122);
          return (
            <g key={d.name} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <circle cx={x} cy={y} r={10} fill="transparent" />
              <circle cx={x} cy={y} r={hover === i ? 5 : 3.5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
              <text x={lx} y={ly} fontSize={11} textAnchor="middle" dominantBaseline="middle" fill={hover === i ? 'var(--text)' : 'var(--text-2)'}>
                {d.name.length > 18 ? `${d.name.slice(0, 17)}…` : d.name}{hover === i ? ` ${Math.round(d.score)}` : ''}
              </text>
            </g>
          );
        })}
      </svg>
      <details><summary>View as table</summary><DimensionBars items={items} /></details>
    </div>
  );
}

export function DimensionBars({ items }: { items: { name: string; score: number | null }[] }) {
  const data = items.filter((i) => i.score != null) as { name: string; score: number }[];
  if (!data.length) return <div className="empty">No measured dimensions yet.</div>;
  return (
    <div>
      {data.map((d) => (
        <div className="bar-row" key={d.name} title={`${d.name}: ${d.score}`}>
          <span>{d.name}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${d.score}%` }} /></div>
          <span style={{ textAlign: 'right' }}>{Math.round(d.score)}</span>
        </div>
      ))}
    </div>
  );
}
