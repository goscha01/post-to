// Thin wrapper around @geos/loghub-client so route code never imports it
// directly. Two reasons:
//   1. Easier to swap to @fixprompt/node once that's published — single import
//      point to change.
//   2. Adds the per-service defaults (service/app/env) so every log line lands
//      with the same labels in Loki.
//
// Synchronous, fire-and-forget. The underlying client buffers and posts in the
// background — if LogHub is unreachable the call resolves and the request
// thread continues. We never want a request to fail because logging failed.

const { loghubLog } = require('@geos/loghub-client');

const SERVICE = 'post-to';
const APP = 'post-to';
const ENV = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';

function send(level, message, attrs) {
  try {
    loghubLog({
      service: SERVICE,
      app: APP,
      env: ENV,
      level,
      message,
      attrs: attrs || {},
    });
  } catch {
    // never throw from a logger
  }
}

module.exports = {
  info: (message, attrs) => send('info', message, attrs),
  warn: (message, attrs) => send('warn', message, attrs),
  error: (message, attrs) => send('error', message, attrs),
  debug: (message, attrs) => send('debug', message, attrs),
};
