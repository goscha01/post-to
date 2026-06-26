// Tiny frontend logger that ships logs to the backend's /api/client-log
// endpoint so they show up in the backend stdout (visible to Claude).
// Use:  import rlog from './utils/remoteLogger';
//       rlog('info', 'AuthContext', 'login.clicked', { forceConsent });
//
// Failures are swallowed — logging must never break the app. Also no-ops in
// production unless REACT_APP_REMOTE_LOG=true.

const BACKEND = process.env.REACT_APP_API_URL || 'http://localhost:3001';
const ENABLED = process.env.NODE_ENV !== 'production' || process.env.REACT_APP_REMOTE_LOG === 'true';

export default function rlog(level, source, message, data) {
  // Always mirror to browser console.
  try {
    const args = [`[${source}] ${message}`];
    if (data !== undefined) args.push(data);
    (console[level] || console.log)(...args);
  } catch (_) {}

  if (!ENABLED) return;

  try {
    // Use sendBeacon for fire-and-forget; fall back to fetch.
    const body = JSON.stringify({
      level, source, message,
      data: data === undefined ? undefined : (data instanceof Error ? { name: data.name, message: data.message, stack: data.stack } : data),
      ts: new Date().toISOString()
    });
    const url = `${BACKEND}/api/client-log`;
    if (navigator.sendBeacon && level !== 'error') {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true
      }).catch(() => {});
    }
  } catch (_) {
    // Don't let logging break the app.
  }
}
