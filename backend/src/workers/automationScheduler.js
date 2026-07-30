// Recurring-automation tick.
//
// Polls automation_rules every 5 minutes. For each row where
// next_run_at <= now() AND active = true AND status = 'idle':
//   1. Claim the row (conditional UPDATE status='running'). Losers skip.
//   2. Hand off to automationExecutor.runRule.
//   3. Executor updates last_run_at + next_run_at and flips status back
//      to 'idle' (via automationsService.markRunComplete).
//
// One instance / one process — no distributed lock. The claim CAS is enough
// for single-worker deployments. If we ever run multiple Railway replicas
// we'd need to key claims by hostname + heartbeat; not there yet.

const automationsService = require('../services/automationsService');
const automationExecutor = require('../services/automationExecutor');
const logger = require('../utils/logger');

const POLL_INTERVAL_MS = Number(process.env.AUTOMATION_SCHEDULER_INTERVAL_MS) || 5 * 60 * 1000;
const BATCH_SIZE = Number(process.env.AUTOMATION_SCHEDULER_BATCH) || 10;

async function tick() {
  let due;
  try {
    due = await automationsService.findDueRules({ limit: BATCH_SIZE });
  } catch (err) {
    logger.warn('automation_scheduler.query_error', { error: err.message });
    return;
  }
  if (!due.length) return;

  logger.info('automation_scheduler.tick', { due_count: due.length });

  for (const rule of due) {
    const claimed = await automationsService.claimRule(rule.id);
    if (!claimed) continue; // another instance already grabbed it (or was manually flipped)

    try {
      await automationExecutor.runRule(claimed, { trigger: 'schedule' });
    } catch (e) {
      // executor.runRule catches internally + logs; this is a safety net for
      // truly unexpected throws (missing service init, etc).
      logger.error('automation_scheduler.uncaught', { rule_id: rule.id, error: e.message });
      // Release the claim so the rule doesn't get stuck in 'running'.
      await automationsService.releaseRule(rule.id).catch(() => {});
    }
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  setTimeout(() => {
    tick().catch((e) => logger.warn('automation_scheduler.tick_error', { error: e.message }));
    setInterval(() => {
      tick().catch((e) => logger.warn('automation_scheduler.tick_error', { error: e.message }));
    }, POLL_INTERVAL_MS);
  }, 10_000);
  logger.info('automation_scheduler.started', { interval_ms: POLL_INTERVAL_MS, batch_size: BATCH_SIZE });
}

module.exports = { start, tick };
