// Display helpers. Number, date and currency formatting goes through Intl with the chosen locale
// (decision 139). `locale` is reactive, so values re-format when the language switches.
import { locale } from './i18n';

const money = (n: number): string => new Intl.NumberFormat(locale.value, {
  style: 'currency', currency: 'USD',
  minimumFractionDigits: Math.abs(n) < 1 ? 4 : 2, maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2,
}).format(n);

export const usd = (n: number | null | undefined): string => (n == null ? '—' : money(n));
export const pct = (n: number | null | undefined): string =>
  n == null ? '—' : new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 0 }).format(n);
/** A 0..100 percentage value (already a percentage, not a fraction), locale-formatted with a % sign. */
export const pctValue = (n: number): string => `${new Intl.NumberFormat(locale.value, { maximumFractionDigits: 0 }).format(n)}%`;
export const int = (n: number): string => new Intl.NumberFormat(locale.value).format(n);
export const dur = (ms: number | null | undefined): string => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${int(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${int(m)}m ${int(s % 60)}s` : `${int(Math.floor(m / 60))}h ${int(m % 60)}m`;
};
export const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
};
