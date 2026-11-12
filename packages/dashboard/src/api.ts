// Metrics API client. All GETs, cookie auth (same-origin), short timeout; on any failure it throws a
// typed ApiError so the UI can show a daemon-off or timeout state instead of blank numbers. When
// VITE_USE_MOCK is set (default in dev/build with no daemon), the mock data is returned instead.
import type { MetricsSummary, RequestsPage, RequestDetail, TriageReport, NowView, Cursor } from './types';
import { mockSummary, mockRequests, mockDetail, mockTriage, mockNow } from './mock';

export type ApiErrorKind = 'daemon_off' | 'timeout' | 'unauthorized' | 'http_error';
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  constructor(kind: ApiErrorKind, message?: string) { super(message ?? kind); this.kind = kind; }
}

const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';
const DEFAULT_TIMEOUT = 5000;

async function getJSON<T>(path: string, timeoutMs = DEFAULT_TIMEOUT): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller.signal });
    if (res.status === 401) throw new ApiError('unauthorized');
    if (!res.ok) throw new ApiError('http_error', `HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError('timeout');
    throw new ApiError('daemon_off');   // network error: the daemon is not reachable
  } finally {
    clearTimeout(timer);
  }
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const api = {
  summary(window: { since?: string; until?: string } = {}): Promise<MetricsSummary> {
    if (USE_MOCK) return Promise.resolve(mockSummary());
    return getJSON(`/router/v1/metrics/summary${qs(window)}`);
  },
  requests(opts: { limit?: number; before?: Cursor | null; level?: string } = {}): Promise<RequestsPage> {
    if (USE_MOCK) return Promise.resolve(mockRequests(opts));
    return getJSON(`/router/v1/metrics/requests${qs({ limit: opts.limit, level: opts.level, before: opts.before ? `${opts.before.closedAt},${opts.before.requestId}` : undefined })}`);
  },
  detail(requestId: string): Promise<RequestDetail> {
    if (USE_MOCK) return Promise.resolve(mockDetail(requestId));
    return getJSON(`/router/v1/metrics/requests/${encodeURIComponent(requestId)}`);
  },
  triage(window: { since?: string } = {}): Promise<TriageReport> {
    if (USE_MOCK) return Promise.resolve(mockTriage());
    return getJSON(`/router/v1/metrics/triage-report${qs(window)}`);
  },
  now(): Promise<NowView> {
    if (USE_MOCK) return Promise.resolve(mockNow());
    return getJSON(`/router/v1/metrics/now`);
  },
};
