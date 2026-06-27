// Logs every incoming HTTP request to LogHub. Captures method, path, status,
// duration, and (when set) the JWT user id. Stays out of the request body —
// route-level logging is responsible for any business-specific detail.
//
// Level routing:
//   2xx/3xx → info
//   4xx     → warn
//   5xx     → error
//
// We attach to res.on('finish') instead of wrapping res.json so streaming
// responses (none today, but possible) are still logged once.

const logger = require('../utils/logger');

function apiLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration_ms = Date.now() - start;
    const status = res.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level]('http_request', {
      method: req.method,
      path: req.originalUrl || req.url,
      status,
      duration_ms,
      user_id: req.user?.userId ?? null,
      ua: req.headers['user-agent']?.slice(0, 200) ?? null,
      ip: req.ip,
    });
  });
  next();
}

module.exports = apiLogger;
