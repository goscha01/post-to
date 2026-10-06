// Thin wrapper around @geos/loghub-client so route code never imports it
// directly. Two reasons:
//   1. Easier to swap to @fixprompt/node once that's published — single import
//      point to change.
//   2. Adds the per-service defaults (service/app/env) so every log line lands
//      with the same labels in Loki.
//
// Also mirrors every call to stdout/stderr. Loghub ingestion can silently fail
// (misconfigured key, broker down) — Railway stdout is the always-on backup
// so a Railway-logs query always sees everything the backend emitted.

const { loghubLog } = require('@geos/loghub-client');

const SERVICE = 'post-to';
const APP = 'post-to';
const ENV = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';

function send(level, message, attrs) {
  // stdout mirror — this is the authoritative local record. Keep it compact
  // so Railway log pages stay readable.
  try {
    const line = attrs && Object.keys(attrs).length
      ? `[${level.toUpperCase()}] ${message} ${JSON.stringify(attrs)}`
      : `[${level.toUpperCase()}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } catch { /* never throw from a logger */ }
  // Loki/FixLoop fan-out — best-effort.
  try {
    loghubLog({
      service: SERVICE,
      app: APP,
      env: ENV,
      level,
      message,
      attrs: attrs || {},
    });
  } catch { /* never throw from a logger */ }
}

module.exports = {
  info: (message, attrs) => send('info', message, attrs),
  warn: (message, attrs) => send('warn', message, attrs),
  error: (message, attrs) => send('error', message, attrs),
  debug: (message, attrs) => send('debug', message, attrs),
};
