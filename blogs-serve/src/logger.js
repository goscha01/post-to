const { loghubLog } = require('@geos/loghub-client');

const SERVICE = 'post-to-blogs';
const APP = 'post-to-blogs';
const ENV = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';

function send(level, message, attrs) {
  try {
    loghubLog({ service: SERVICE, app: APP, env: ENV, level, message, attrs: attrs || {} });
  } catch { /* never throw from a logger */ }
}

module.exports = {
  info: (m, a) => send('info', m, a),
  warn: (m, a) => send('warn', m, a),
  error: (m, a) => send('error', m, a),
  debug: (m, a) => send('debug', m, a),
};
