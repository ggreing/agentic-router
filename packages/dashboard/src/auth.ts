// One-time login bootstrap (decision 132). `do-it-all-claude-code dashboard` opens the page with a one-time code
// in the URL fragment (…/dashboard#code=<code>). The page reads it, POSTs it once to /dashboard/auth to
// receive the HttpOnly session cookie, then clears the fragment with history.replaceState so the code never
// lingers in the address bar or history. The code is single-use and short-lived; the long-lived token
// never reaches the browser. In mock mode (no daemon) this is a no-op.
const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';

export async function bootstrapAuth(): Promise<void> {
  if (USE_MOCK || typeof window === 'undefined') return;
  const m = (window.location.hash || '').match(/(?:^#|&)code=([^&]+)/);
  if (!m) return;                       // returning viewer with an existing cookie, or no code
  const code = decodeURIComponent(m[1]!);
  try {
    await fetch('/dashboard/auth', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    // the daemon may be down; the views then show their daemon-not-running / session state
  } finally {
    // drop the code from the URL and history whether or not the exchange succeeded
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignore */ }
  }
}
