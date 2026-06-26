// Tracks AI generation jobs in the ai_jobs table.
// Provides: createJob, completeJob, failJob, countTodayByKind.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Daily caps (safety nets, can be overridden via env).
const DAILY_CAPS = {
  article_generation: parseInt(process.env.AI_DAILY_ARTICLE_CAP, 10) || 10,
  review_post_generation: parseInt(process.env.AI_DAILY_REVIEW_POST_CAP, 10) || 50
};

async function createJob({ userId, kind, model, inputJson }) {
  const { data, error } = await supabase
    .from('ai_jobs')
    .insert({
      user_id: userId,
      kind,
      status: 'running',
      model,
      input_json: inputJson || null
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create ai_jobs row: ${error.message}`);
  return data;
}

async function completeJob(jobId, { prompt, outputJson, model, usage, costUsd, resultTable, resultId }) {
  const update = {
    status: 'done',
    prompt: prompt || null,
    output_json: outputJson || null,
    model: model || null,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
    cost_usd: costUsd ?? null,
    result_table: resultTable || null,
    result_id: resultId || null,
    completed_at: new Date().toISOString()
  };
  const { error } = await supabase.from('ai_jobs').update(update).eq('id', jobId);
  if (error) console.error('Failed to mark ai_jobs done:', error.message);
}

async function failJob(jobId, errorMessage, { prompt } = {}) {
  const update = {
    status: 'failed',
    error: String(errorMessage || 'unknown error').slice(0, 4000),
    completed_at: new Date().toISOString()
  };
  if (prompt) update.prompt = prompt;
  const { error } = await supabase.from('ai_jobs').update(update).eq('id', jobId);
  if (error) console.error('Failed to mark ai_jobs failed:', error.message);
}

// Returns count of successful + running jobs for this user/kind today (UTC).
async function countTodayByKind(userId, kind) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('ai_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', kind)
    .in('status', ['running', 'done'])
    .gte('created_at', startOfDay.toISOString());

  if (error) {
    // Fail open on counting errors — don't block users due to infra hiccups.
    console.error('countTodayByKind failed:', error.message);
    return 0;
  }
  return count || 0;
}

function dailyCapFor(kind) {
  return DAILY_CAPS[kind] || 0;
}

module.exports = {
  createJob,
  completeJob,
  failJob,
  countTodayByKind,
  dailyCapFor
};
