// Small display helpers shared by the views. No locale assumptions beyond the browser's.
export const usd = (n: number | null | undefined): string => (n == null ? '—' : `$${n.toFixed(n < 1 ? 4 : 2)}`);
export const pct = (n: number | null | undefined): string => (n == null ? '—' : `${(n * 100).toFixed(0)}%`);
export const dur = (ms: number | null | undefined): string => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};
