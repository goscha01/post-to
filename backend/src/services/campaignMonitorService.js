// Campaign Assistant — auto-monitor for observation steps.
//
// Runs periodically (in-process 6h interval, plus /monitor/tick endpoint for
// external cron triggers). For each pending observation step whose monitor_spec
// is set and check_after has passed, pulls the current metric and compares
// against the AI-emitted threshold. Marks done when the target is met, or
// 'failed' with an audit note when check_until closes without a hit.
//
// The AI is trusted to emit the spec correctly (source + params + threshold +
// check_after + check_until). This service is a strict evaluator — it does not
// invent parameters or infer intent. If a spec is malformed or the referenced
// account/property is unavailable, the step is left alone and an error note
// is stored on last_check_summary.

const { createClient } = require('@supabase/supabase-js');
const { getAllBusinessTokens } = require('../utils/businessTokens');
const analyticsService = require('./analyticsService');
const googleAdsService = require('./googleAdsService');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const SUPPORTED_SOURCES = new Set(['ga4_event_rate', 'ga4_event_count', 'google_ads_geo_share']);
const SUPPORTED_OPS = new Set(['<', '<=', '>', '>=', '==']);

// -- Threshold evaluator ------------------------------------------------------

function evalThreshold(value, threshold) {
  if (!threshold || typeof value !== 'number' || Number.isNaN(value)) return false;
  const { op, value: target } = threshold;
  if (!SUPPORTED_OPS.has(op) || typeof target !== 'number') return false;
  switch (op) {
    case '<':  return value <  target;
    case '<=': return value <= target;
    case '>':  return value >  target;
    case '>=': return value >= target;
    case '==': return value === target;
    default:   return false;
  }
}

// -- Metric sources -----------------------------------------------------------

// Ratio between two GA4 event counts over a lookback window.
// e.g. purchase_cancelled / purchase_started over 14 days.
async function evalGa4EventRate({ token, propertyId, params }) {
  const days = Math.max(1, Math.min(90, Number(params.days) || 14));
  const { rows } = await analyticsService.getEvents(token, propertyId, days);
  const num = rows.find(r => r.eventName === params.numerator_event)?.eventCount ?? 0;
  const den = rows.find(r => r.eventName === params.denominator_event)?.eventCount ?? 0;
  if (den === 0) {
    return {
      value: null,
      summary: `${params.numerator_event}/${params.denominator_event} over ${days}d: denominator is 0 (no events yet)`,
    };
  }
  const rate = num / den;
  return {
    value: rate,
    summary: `${params.numerator_event}=${num} / ${params.denominator_event}=${den} over ${days}d → rate=${(rate * 100).toFixed(1)}%`,
  };
}

// Raw event count for a single GA4 event over a lookback window.
// e.g. trial_started events in the last 2 days.
async function evalGa4EventCount({ token, propertyId, params }) {
  const days = Math.max(1, Math.min(90, Number(params.days) || 7));
  const { rows } = await analyticsService.getEvents(token, propertyId, days);
  const count = rows.find(r => r.eventName === params.event_name)?.eventCount ?? 0;
  return {
    value: count,
    summary: `${params.event_name} over ${days}d → count=${count}`,
  };
}

// Impression share for a specific country criterion in Google Ads geo report.
// e.g. what % of impressions came from South Korea (criterion 2410).
async function evalGoogleAdsGeoShare({ token, customerId, loginCustomerId, campaignId, params }) {
  const days = Math.max(1, Math.min(90, Number(params.days) || 7));
  const rows = await googleAdsService.getLocations(token, customerId, days, { loginCustomerId, campaignId });
  const targetCid = String(params.country_criterion_id || '');
  const totalImp = rows.reduce((s, r) => s + (r.impressions || 0), 0);
  const targetImp = rows
    .filter(r => r.countryCriterionId === targetCid)
    .reduce((s, r) => s + (r.impressions || 0), 0);
  if (totalImp === 0) {
    return {
      value: null,
      summary: `Geo report over ${days}d: 0 impressions (campaign may be paused)`,
    };
  }
  const share = targetImp / totalImp;
  return {
    value: share,
    summary: `Country criterion ${targetCid}: ${targetImp}/${totalImp} impressions over ${days}d → share=${(share * 100).toFixed(1)}%`,
  };
}

// -- Dispatch ----------------------------------------------------------------

async function evaluateSpec({ spec, userId, conversation }) {
  const source = spec?.source;
  if (!SUPPORTED_SOURCES.has(source)) {
    return { error: `unsupported source: ${source}` };
  }
  const params = spec.params || {};

  // Resolve token for the owner of the target account.
  // Both GA4 and Ads services need an OAuth access token from the correct
  // Google account. We pick the token by matching owner_google_id if stored
  // on the connected_account; otherwise fall back to the first token.
  const tokens = await getAllBusinessTokens(userId);
  if (!tokens || tokens.length === 0) return { error: 'no business tokens for user' };
  const token = tokens[0].access_token;

  try {
    if (source === 'ga4_event_rate' || source === 'ga4_event_count') {
      const propertyId = conversation.ga4_property_id;
      if (!propertyId) return { error: 'conversation has no ga4_property_id' };
      const evalFn = source === 'ga4_event_rate' ? evalGa4EventRate : evalGa4EventCount;
      return await evalFn({ token, propertyId, params });
    }
    if (source === 'google_ads_geo_share') {
      const customerId = conversation.google_ads_customer_id;
      if (!customerId) return { error: 'conversation has no google_ads_customer_id' };
      return await evalGoogleAdsGeoShare({
        token,
        customerId,
        loginCustomerId: conversation.google_ads_login_customer_id || null,
        campaignId: conversation.campaign_id,
        params,
      });
    }
  } catch (err) {
    return { error: err.message || String(err) };
  }
  return { error: 'unreachable' };
}

// -- Tick: walk all due observation steps and evaluate ------------------------

async function runMonitorTick({ limit = 100, stepIds = null, ignoreSchedule = false } = {}) {
  const nowIso = new Date().toISOString();
  let query = supabase
    .from('campaign_assistant_action_plan_steps')
    .select('id, plan_id, status, title, monitor_spec, check_after, check_until, last_check_at')
    .not('monitor_spec', 'is', null);
  if (stepIds && stepIds.length > 0) {
    query = query.in('id', stepIds);
    if (!ignoreSchedule) {
      query = query.eq('status', 'pending').lte('check_after', nowIso);
    }
  } else {
    query = query
      .eq('status', 'pending')
      .lte('check_after', nowIso)
      .order('check_after', { ascending: true });
  }
  const { data: dueSteps, error } = await query.limit(limit);
  if (error) throw new Error(`monitor tick fetch failed: ${error.message}`);

  const results = { evaluated: 0, marked_done: 0, marked_failed: 0, still_pending: 0, errors: 0 };
  for (const step of dueSteps || []) {
    try {
      // Resolve conversation (via plan_id → plan.conversation_id).
      const { data: plan } = await supabase
        .from('campaign_assistant_action_plans')
        .select('conversation_id')
        .eq('id', step.plan_id)
        .single();
      if (!plan) { results.errors += 1; continue; }
      const { data: conv } = await supabase
        .from('campaign_assistant_conversations')
        .select('id, user_id, google_ads_customer_id, google_ads_login_customer_id, campaign_id, ga4_property_id')
        .eq('id', plan.conversation_id)
        .single();
      if (!conv) { results.errors += 1; continue; }

      const result = await evaluateSpec({ spec: step.monitor_spec, userId: conv.user_id, conversation: conv });
      results.evaluated += 1;

      const patch = {
        last_check_at: nowIso,
        last_check_value: { value: result.value ?? null, summary: result.summary || null, error: result.error || null },
        last_check_summary: result.error ? `[error] ${result.error}` : result.summary,
      };

      if (result.error) {
        // Leave step pending; store the error so the UI can surface it.
        await supabase.from('campaign_assistant_action_plan_steps').update(patch).eq('id', step.id);
        results.errors += 1;
        continue;
      }

      const targetMet = evalThreshold(result.value, step.monitor_spec.threshold);
      if (targetMet) {
        patch.status = 'done';
        patch.notes = await prependNote(step.id, `[auto-monitor ${nowIso}] Target met — ${result.summary}`);
        await supabase.from('campaign_assistant_action_plan_steps').update(patch).eq('id', step.id);
        results.marked_done += 1;
      } else if (step.check_until && new Date(step.check_until).getTime() <= Date.now()) {
        patch.status = 'failed';
        patch.notes = await prependNote(step.id, `[auto-monitor ${nowIso}] Window closed without hitting target — ${result.summary}`);
        await supabase.from('campaign_assistant_action_plan_steps').update(patch).eq('id', step.id);
        results.marked_failed += 1;
      } else {
        await supabase.from('campaign_assistant_action_plan_steps').update(patch).eq('id', step.id);
        results.still_pending += 1;
      }
    } catch (err) {
      results.errors += 1;
      logger.error('campaignMonitor.step_eval_failed', { stepId: step.id, error: err.message });
    }
  }
  logger.info('campaignMonitor.tick', { ...results, due_count: (dueSteps || []).length });
  return results;
}

// Prepend a monitor audit line to the step notes so the user can see the
// evaluation history without losing prior context. Notes column is a plain
// TEXT so we do a read-modify-write.
async function prependNote(stepId, line) {
  const { data } = await supabase
    .from('campaign_assistant_action_plan_steps')
    .select('notes')
    .eq('id', stepId)
    .single();
  const existing = data?.notes ? `\n\n---\n\n${data.notes}` : '';
  return `${line}${existing}`;
}

// -- Spec validator (used by prompt-emitted specs before they reach the DB) --
//
// We don't want the AI's freeform JSON polluting the steps table. Every field
// is coerced to a known shape or the whole spec is rejected.
function safeParseMonitorSpec(rawSpec) {
  if (!rawSpec || typeof rawSpec !== 'object') return null;
  const source = String(rawSpec.source || '');
  if (!SUPPORTED_SOURCES.has(source)) return null;
  const threshold = rawSpec.threshold;
  if (!threshold || !SUPPORTED_OPS.has(threshold.op) || typeof threshold.value !== 'number') return null;
  const params = rawSpec.params && typeof rawSpec.params === 'object' ? rawSpec.params : {};
  const cleanParams = {};
  if (source === 'ga4_event_rate') {
    if (!params.numerator_event || !params.denominator_event) return null;
    cleanParams.numerator_event = String(params.numerator_event).slice(0, 100);
    cleanParams.denominator_event = String(params.denominator_event).slice(0, 100);
    cleanParams.days = clampInt(params.days, 1, 90, 14);
  } else if (source === 'ga4_event_count') {
    if (!params.event_name) return null;
    cleanParams.event_name = String(params.event_name).slice(0, 100);
    cleanParams.days = clampInt(params.days, 1, 90, 7);
  } else if (source === 'google_ads_geo_share') {
    if (!params.country_criterion_id) return null;
    cleanParams.country_criterion_id = String(params.country_criterion_id).slice(0, 20);
    cleanParams.days = clampInt(params.days, 1, 90, 7);
  }
  return {
    source,
    params: cleanParams,
    threshold: { op: threshold.op, value: Number(threshold.value) },
    target_description: rawSpec.target_description ? String(rawSpec.target_description).slice(0, 500) : null,
  };
}

function clampInt(v, min, max, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

module.exports = {
  runMonitorTick,
  safeParseMonitorSpec,
  SUPPORTED_SOURCES,
  SUPPORTED_OPS,
};
