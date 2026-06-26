// Tiny endpoint so the React frontend can ship console-style logs into the
// backend's stdout where Claude (or any tail) can see them.
// Auth-less by design — it's local-dev only. In production, gate via NODE_ENV
// or remove the mount in index.js.

const express = require('express');
const router = express.Router();

router.post('/', (req, res) => {
  const { level = 'info', source = 'frontend', message = '', data, ts } = req.body || {};
  const stamp = ts || new Date().toISOString();
  const lvl = String(level).toUpperCase().padEnd(5);
  const tag = `[CLIENT ${stamp} ${lvl} ${source}]`;
  if (data !== undefined) {
    console.log(tag, message, typeof data === 'string' ? data : JSON.stringify(data));
  } else {
    console.log(tag, message);
  }
  res.status(204).end();
});

module.exports = router;
