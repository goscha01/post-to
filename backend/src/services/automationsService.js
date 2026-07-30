// CRUD + cadence math for automation_rules.
//
// The scheduler cares about `next_run_at` — that's the single field it
// queries against `NOW()`. We compute it here on create, update, and after
// every run.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const TABLE = 'automation_rules';

const RULE_KINDS = ['blog', 'social_post'];
const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const TOPIC_SOURCES = ['ai_pick', 'topic_list'];
const IMAGE_SOURCES = ['none', 'fixed', 'ai_generate'];

const PUBLIC_FIELDS = [
  'id', 'user_id', 'name', 'kind',
  'cadence', 'targets',
  'topic_source', 'topics', 'topic_cursor',
  'image_source', 'image_prompt_template', 'fixed_image_url',
  'business_context',
  'auto_publish', 'active', 'status',
  'next_run_at', 'last_run_at',
  'created_at', 'updated_at',
].join(', ');

// Compute the next UTC firing after `from` given the rule's cadence.
// cadence: { frequency, day_of_week?, day_of_month?, time_of_day: 'HH:MM' }
function computeNextRunAt(cadence, from = new Date()) {
  const c = cadence || {};
  const freq = c.frequency;
  if (!FREQUENCIES.includes(freq)) return null;

  const [hh, mm] = String(c.time_of_day || '09:00').split(':').map((n) => parseInt(n, 10) || 0);
  const base = new Date(from);
  base.setUTCSeconds(0, 0);

  if (freq === 'daily') {
    const next = new Date(base);
    next.setUTCHours(hh, mm, 0, 0);
    if (next <= base) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  if (freq === 'weekly') {
    const target = Math.min(6, Math.max(0, parseInt(c.day_of_week, 10) || 0));
    const next = new Date(base);
    next.setUTCHours(hh, mm, 0, 0);
    let diff = target - next.getUTCDay();
    if (diff < 0 || (diff === 0 && next <= base)) diff += 7;
    next.setUTCDate(next.getUTCDate() + diff);
    return next;
  }

  if (freq === 'monthly') {
    const dom = Math.min(28, Math.max(1, parseInt(c.day_of_month, 10) || 1));
    const next = new Date(base);
    next.setUTCDate(dom);
    next.setUTCHours(hh, mm, 0, 0);
    if (next <= base) {
      next.setUTCMonth(next.getUTCMonth() + 1);
      next.setUTCDate(dom);
      next.setUTCHours(hh, mm, 0, 0);
    }
    return next;
  }

  return null;
}

function validateRule(input) {
  const errs = [];
  if (!input.name || String(input.name).trim().length === 0) errs.push('name required');
  if (!RULE_KINDS.includes(input.kind)) errs.push(`kind must be one of ${RULE_KINDS.join(',')}`);
  const cadence = input.cadence || {};
  if (!FREQUENCIES.includes(cadence.frequency)) errs.push(`cadence.frequency must be one of ${FREQUENCIES.join(',')}`);
  if (cadence.time_of_day && !/^\d{1,2}:\d{2}$/.test(cadence.time_of_day)) errs.push('cadence.time_of_day must be HH:MM');
  if (cadence.frequency === 'weekly' && (cadence.day_of_week == null || cadence.day_of_week < 0 || cadence.day_of_week > 6))
    errs.push('cadence.day_of_week (0-6) required for weekly');
  if (cadence.frequency === 'monthly' && (cadence.day_of_month == null || cadence.day_of_month < 1 || cadence.day_of_month > 28))
    errs.push('cadence.day_of_month (1-28) required for monthly');

  if (input.topic_source && !TOPIC_SOURCES.includes(input.topic_source)) errs.push(`topic_source must be one of ${TOPIC_SOURCES.join(',')}`);
  if (input.topic_source === 'topic_list' && (!Array.isArray(input.topics) || input.topics.length === 0))
    errs.push('topics[] required when topic_source is topic_list');

  if (input.image_source && !IMAGE_SOURCES.includes(input.image_source)) errs.push(`image_source must be one of ${IMAGE_SOURCES.join(',')}`);
  if (input.image_source === 'fixed' && !input.fixed_image_url) errs.push('fixed_image_url required when image_source is fixed');

  const targets = input.targets || [];
  if (!Array.isArray(targets) || targets.length === 0) errs.push('targets[] required (at least one destination)');

  if (input.kind === 'blog') {
    // Blog automations always publish to all verified blog domains, but the
    // user still has to say "yes I want blogs published" by providing at
    // least one target of type='blog'.
    if (!targets.some((t) => t?.type === 'blog')) errs.push('blog automation needs at least one target of type=blog');
  } else if (input.kind === 'social_post') {
    for (const t of targets) {
      if (!['gmb', 'facebook', 'instagram'].includes(t?.type))
        errs.push(`social_post target.type must be gmb|facebook|instagram (got ${t?.type})`);
    }
  }

  return errs;
}

function normalizeInput(input) {
  const cadence = input.cadence || {};
  return {
    name: String(input.name || '').slice(0, 255),
    kind: input.kind,
    cadence: {
      frequency: cadence.frequency,
      time_of_day: cadence.time_of_day || '09:00',
      day_of_week: cadence.frequency === 'weekly' ? Number(cadence.day_of_week) : null,
      day_of_month: cadence.frequency === 'monthly' ? Number(cadence.day_of_month) : null,
    },
    targets: Array.isArray(input.targets) ? input.targets : [],
    topic_source: input.topic_source || 'ai_pick',
    topics: Array.isArray(input.topics) ? input.topics : [],
    topic_cursor: Number.isInteger(input.topic_cursor) ? input.topic_cursor : 0,
    image_source: input.image_source || 'none',
    image_prompt_template: input.image_prompt_template || null,
    fixed_image_url: input.fixed_image_url || null,
    business_context: input.business_context || {},
    auto_publish: !!input.auto_publish,
    active: input.active === false ? false : true,
  };
}

async function listForUser(userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(PUBLIC_FIELDS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getForUser(userId, id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(PUBLIC_FIELDS)
    .eq('user_id', userId).eq('id', id).single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
}

async function createRule(userId, input) {
  const errs = validateRule(input);
  if (errs.length) { const err = new Error(errs.join('; ')); err.status = 400; throw err; }
  const norm = normalizeInput(input);
  const nextRun = computeNextRunAt(norm.cadence);
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ user_id: userId, ...norm, next_run_at: nextRun ? nextRun.toISOString() : null })
    .select(PUBLIC_FIELDS).single();
  if (error) throw error;
  return data;
}

async function updateRule(userId, id, input) {
  // Load current so we can validate the merged shape.
  const current = await getForUser(userId, id);
  if (!current) { const err = new Error('Not found'); err.status = 404; throw err; }
  const merged = { ...current, ...input };
  // cadence / targets / topics need deep-merge to accept partial updates.
  if (input.cadence) merged.cadence = { ...(current.cadence || {}), ...input.cadence };
  const errs = validateRule(merged);
  if (errs.length) { const err = new Error(errs.join('; ')); err.status = 400; throw err; }
  const norm = normalizeInput(merged);
  const nextRun = computeNextRunAt(norm.cadence);
  const { data, error } = await supabase
    .from(TABLE)
    .update({ ...norm, next_run_at: nextRun ? nextRun.toISOString() : null })
    .eq('user_id', userId).eq('id', id)
    .select(PUBLIC_FIELDS).single();
  if (error) throw error;
  return data;
}

async function deleteRule(userId, id) {
  const { error } = await supabase.from(TABLE).delete().eq('user_id', userId).eq('id', id);
  if (error) throw error;
}

// Called by the scheduler after a run finishes. Advances the topic cursor
// (if topic_list) and stamps last_run + next_run for the next tick.
async function markRunComplete(id, { advanceTopic = false, cadence } = {}) {
  const patch = {
    status: 'idle',
    last_run_at: new Date().toISOString(),
    next_run_at: computeNextRunAt(cadence)?.toISOString() || null,
  };
  if (advanceTopic) {
    // We fetch topics + cursor to advance safely without a read-modify-write
    // race — the scheduler serializes runs per rule by claim, so this is safe.
    const { data: r } = await supabase.from(TABLE)
      .select('topics, topic_cursor').eq('id', id).single();
    if (r) {
      const total = Array.isArray(r.topics) ? r.topics.length : 0;
      patch.topic_cursor = total > 0 ? ((r.topic_cursor || 0) + 1) % total : 0;
    }
  }
  const { error } = await supabase.from(TABLE).update(patch).eq('id', id);
  if (error) throw error;
}

async function claimRule(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: 'running' })
    .eq('id', id)
    .eq('status', 'idle')
    .select(PUBLIC_FIELDS).single();
  if (error || !data) return null;
  return data;
}

async function releaseRule(id) {
  await supabase.from(TABLE).update({ status: 'idle' }).eq('id', id);
}

async function findDueRules({ limit = 20 } = {}) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .select(PUBLIC_FIELDS)
    .eq('active', true)
    .eq('status', 'idle')
    .lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

module.exports = {
  listForUser, getForUser,
  createRule, updateRule, deleteRule,
  claimRule, releaseRule, markRunComplete, findDueRules,
  computeNextRunAt,
  RULE_KINDS, FREQUENCIES, TOPIC_SOURCES, IMAGE_SOURCES,
  _internal: { validateRule, normalizeInput },
};
