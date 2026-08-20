// Campaign Assistant — dual-provider streaming chat over a Google Ads +
// GA4 + Firebase-events + OpenAI-Ads report snapshot.
//
// Two providers run in parallel per user turn so the user can compare
// recommendations side by side:
//   - OpenAI  (default: gpt-4o)      — automatic prompt caching on prefixes ≥1024 tokens
//   - Claude  (default: claude-sonnet-4-6) — explicit prompt caching via
//                                     cache_control: {type: 'ephemeral'} on
//                                     the report-JSON system-prompt block.
//
// The report JSON is passed as a fixed, stable prefix so both providers
// cache-hit on every follow-up turn (5-min ephemeral TTL on Claude, similar
// on OpenAI). This is what makes multi-turn chat over a big data blob
// affordable.
//
// Adapters are callback-based (onDelta, onComplete, onError) so the caller
// (routes/campaignAssistant.js) can multiplex both streams onto one SSE
// connection to the browser.

const axios = require('axios');
const logger = require('../utils/logger');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const OPENAI_MODEL = process.env.CAMPAIGN_ASSISTANT_OPENAI_MODEL || 'gpt-4o';
const CLAUDE_MODEL = process.env.CAMPAIGN_ASSISTANT_CLAUDE_MODEL || 'claude-sonnet-4-6';

// USD per 1K tokens. Best-effort — update as pricing pages change.
const PRICING = {
  'gpt-4o':            { prompt: 0.0025,  completion: 0.01,   cached_prompt: 0.00125 },
  'gpt-4o-mini':       { prompt: 0.00015, completion: 0.0006, cached_prompt: 0.000075 },
  'gpt-4.1':           { prompt: 0.002,   completion: 0.008,  cached_prompt: 0.0005 },
  'gpt-4.1-mini':      { prompt: 0.0004,  completion: 0.0016, cached_prompt: 0.0001 },
  'claude-sonnet-4-6': { prompt: 0.003,   completion: 0.015,  cache_write: 0.00375, cache_read: 0.0003 },
  'claude-sonnet-4-5': { prompt: 0.003,   completion: 0.015,  cache_write: 0.00375, cache_read: 0.0003 },
  'claude-opus-4-7':   { prompt: 0.015,   completion: 0.075,  cache_write: 0.01875, cache_read: 0.0015 },
  'claude-opus-4-1':   { prompt: 0.015,   completion: 0.075,  cache_write: 0.01875, cache_read: 0.0015 },
};

const SYSTEM_PREAMBLE_TEMPLATE = ({ campaignName, days }) => `You are a senior paid-search and paid-social strategist for a local service business. Your job is to review a full account snapshot (Google Ads campaigns, GA4 sessions and conversions, Firebase app events when present, and prior OpenAI Ads spend and creative history) and give sharp, actionable recommendations to improve ${campaignName ? `the "${campaignName}" campaign` : 'the selected campaign'} over the next ${days || 30} days.

OUTPUT FORMAT — this is important. The UI renders each issue as a collapsible card, so structure your response like this:

## <Short specific issue title>
**Fix:** <one sentence, imperative — the exact action to take>

<Optional details: 1-4 short paragraphs and/or short bullet lists with the specific numbers, root cause, and any secondary actions. Keep it concise — the user has to expand this to see it.>

## <Next issue title>
**Fix:** ...

Rules:
- One "##" heading per issue. No "###" subheadings inside an issue.
- The **Fix:** line MUST be the first line under the heading — the UI shows it collapsed. Everything else is hidden until the user expands.
- If tracking or tagging looks broken (missing primary conversion action, low click-to-session rate, weak Quality Score, high install → 0 first_open drop-off on Firebase), put those issues FIRST. They block everything else.
- Ground every fix and detail in a specific number from the data. Cite exact values ("Search term 'roof repair tampa' spent $47 with 0 conversions", "Click-to-session rate of 43% suggests broken auto-tagging").
- Rank issues by expected impact. Include a rough impact estimate in the details when possible ("could reduce wasted spend by ~$X/mo", "could add ~Y conversions/mo").
- If the data does not contain enough signal to answer, say so plainly — do NOT invent numbers.

For follow-up questions (not the initial analysis), if the user asks something conversational ("why is CTR dropping?", "explain X"), you may respond as plain markdown without the ## Fix format. The ## Fix format is for issue lists only.`;

function buildOpenAiSystemContent(report) {
  const preamble = SYSTEM_PREAMBLE_TEMPLATE({
    campaignName: report?.account?.descriptiveName || null,
    days: report?.meta?.dateRangeDays,
  });
  return `${preamble}

--- BEGIN CAMPAIGN DATA (JSON) ---
${JSON.stringify(report)}
--- END CAMPAIGN DATA ---`;
}

function buildClaudeSystemArray(report) {
  const preamble = SYSTEM_PREAMBLE_TEMPLATE({
    campaignName: report?.account?.descriptiveName || null,
    days: report?.meta?.dateRangeDays,
  });
  // Two-part system so the (large, stable) report JSON gets its own cache
  // breakpoint. Follow-up turns re-send the same prefix → cache hit → ~10%
  // of full input cost.
  return [
    { type: 'text', text: preamble },
    {
      type: 'text',
      text: `--- BEGIN CAMPAIGN DATA (JSON) ---\n${JSON.stringify(report)}\n--- END CAMPAIGN DATA ---`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// Attachment schema (both providers):
//   { type: 'image', mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif', data: '<base64>' }
// Anything else is silently dropped — keep the surface small. Both providers'
// current vision models accept these four image types inline as base64.
const ALLOWED_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a || a.type !== 'image') continue;
    if (!ALLOWED_IMAGE_MEDIA_TYPES.has(a.mediaType)) continue;
    if (typeof a.data !== 'string' || a.data.length === 0) continue;
    out.push({ type: 'image', mediaType: a.mediaType, data: a.data });
  }
  return out;
}

// Wrap the FINAL user message with an image-carrying content array so both
// providers can consume it. The prior conversation history stays as plain
// { role, content: string } — attachments only travel with the current turn.
function withAttachmentsOpenAI(messages, attachments) {
  if (!attachments.length || !messages.length) return messages;
  const rest = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return messages;
  const content = [
    { type: 'text', text: last.content || '' },
    ...attachments.map(a => ({
      type: 'image_url',
      image_url: { url: `data:${a.mediaType};base64,${a.data}` },
    })),
  ];
  return [...rest, { role: 'user', content }];
}

function withAttachmentsClaude(messages, attachments) {
  if (!attachments.length || !messages.length) return messages;
  const rest = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return messages;
  const content = [
    ...attachments.map(a => ({
      type: 'image',
      source: { type: 'base64', media_type: a.mediaType, data: a.data },
    })),
    { type: 'text', text: last.content || '' },
  ];
  return [...rest, { role: 'user', content }];
}

// ---------------------------------------------------------------------------
// OpenAI streaming
// ---------------------------------------------------------------------------
async function streamOpenAI({ report, messages, attachments, onDelta, onComplete, onError }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    onError(new Error('OPENAI_API_KEY is not configured'));
    return;
  }

  const attach = normalizeAttachments(attachments);
  const withAttach = withAttachmentsOpenAI(messages, attach);

  const body = {
    model: OPENAI_MODEL,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: buildOpenAiSystemContent(report) },
      ...withAttach,
    ],
    temperature: 0.5,
  };

  let resp;
  try {
    resp = await axios.post(OPENAI_URL, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'stream',
      timeout: 180_000,
    });
  } catch (err) {
    onError(err);
    return;
  }

  let acc = '';
  let usage = null;
  let modelUsed = OPENAI_MODEL;
  let buf = '';
  let settled = false;

  const settle = (result, err) => {
    if (settled) return;
    settled = true;
    if (err) onError(err);
    else onComplete(result);
  };

  resp.data.on('data', chunk => {
    buf += chunk.toString('utf8');
    // SSE frames are separated by \n\n; within a frame, lines are prefixed "data:".
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const raw of parts) {
      const line = raw.trim();
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          acc += delta;
          try { onDelta(delta); } catch (_) { /* delta handler must not kill stream */ }
        }
        if (j.usage) usage = j.usage;
        if (j.model) modelUsed = j.model;
      } catch (_) { /* ignore malformed frames */ }
    }
  });

  resp.data.on('end', () => {
    const promptTokens = usage?.prompt_tokens || 0;
    const completionTokens = usage?.completion_tokens || 0;
    const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
    const costUsd = costOpenAI(modelUsed, {
      promptTokens, completionTokens, cachedPromptTokens: cached,
    });
    settle({
      provider: 'openai',
      model: modelUsed,
      content: acc,
      promptTokens,
      completionTokens,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      totalTokens: promptTokens + completionTokens,
      costUsd,
    });
  });

  resp.data.on('error', err => settle(null, err));
}

// ---------------------------------------------------------------------------
// Claude (Anthropic) streaming
// ---------------------------------------------------------------------------
async function streamClaude({ report, messages, attachments, onDelta, onComplete, onError }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    onError(new Error('ANTHROPIC_API_KEY is not configured'));
    return;
  }

  const attach = normalizeAttachments(attachments);
  const withAttach = withAttachmentsClaude(messages, attach);

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    stream: true,
    system: buildClaudeSystemArray(report),
    messages: withAttach,
    temperature: 0.5,
  };

  let resp;
  try {
    resp = await axios.post(ANTHROPIC_URL, body, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      responseType: 'stream',
      timeout: 180_000,
    });
  } catch (err) {
    onError(err);
    return;
  }

  let acc = '';
  let modelUsed = CLAUDE_MODEL;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let buf = '';
  let settled = false;

  const settle = (result, err) => {
    if (settled) return;
    settled = true;
    if (err) onError(err);
    else onComplete(result);
  };

  resp.data.on('data', chunk => {
    buf += chunk.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const raw of parts) {
      const line = raw.trim();
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      try {
        const j = JSON.parse(payload);
        if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
          acc += j.delta.text;
          try { onDelta(j.delta.text); } catch (_) { /* delta handler must not kill stream */ }
        } else if (j.type === 'message_start' && j.message) {
          if (j.message.model) modelUsed = j.message.model;
          if (j.message.usage) {
            usage.input_tokens = j.message.usage.input_tokens || 0;
            usage.cache_read_input_tokens = j.message.usage.cache_read_input_tokens || 0;
            usage.cache_creation_input_tokens = j.message.usage.cache_creation_input_tokens || 0;
          }
        } else if (j.type === 'message_delta' && j.usage) {
          usage.output_tokens = j.usage.output_tokens || 0;
        }
      } catch (_) { /* ignore malformed frames */ }
    }
  });

  resp.data.on('end', () => {
    const costUsd = costClaude(modelUsed, {
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
    });
    settle({
      provider: 'claude',
      model: modelUsed,
      content: acc,
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
      costUsd,
    });
  });

  resp.data.on('error', err => settle(null, err));
}

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------
function costOpenAI(model, { promptTokens, completionTokens, cachedPromptTokens }) {
  const p = PRICING[model] || PRICING['gpt-4o'];
  const nonCached = Math.max(0, promptTokens - cachedPromptTokens);
  const promptCost = nonCached / 1000 * p.prompt
    + cachedPromptTokens / 1000 * (p.cached_prompt ?? p.prompt);
  const completionCost = completionTokens / 1000 * p.completion;
  return Number((promptCost + completionCost).toFixed(6));
}

function costClaude(model, { promptTokens, completionTokens, cacheRead, cacheWrite }) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  // Anthropic's `input_tokens` excludes cache_read + cache_creation.
  const promptCost = promptTokens / 1000 * p.prompt
    + cacheWrite / 1000 * (p.cache_write ?? p.prompt)
    + cacheRead / 1000 * (p.cache_read ?? p.prompt);
  const completionCost = completionTokens / 1000 * p.completion;
  return Number((promptCost + completionCost).toFixed(6));
}

// Filter a conversation's message history down to what a given provider
// should see. Each user turn is visible to both providers. Assistant turns
// are provider-specific — we don't want OpenAI reading Claude's answer and
// vice versa (avoids stylistic drift + doubles the effective context).
function messagesForProvider(dbMessages, provider) {
  const out = [];
  for (const m of dbMessages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant' && m.provider === provider && m.status === 'complete' && m.content) {
      out.push({ role: 'assistant', content: m.content });
    }
  }
  return out;
}

// The initial "auto-analysis" user turn. Injected server-side when a fresh
// conversation is created so the assistant produces a ranked recommendation
// list without the user having to type anything.
const INITIAL_ANALYSIS_PROMPT =
  'Please analyse this campaign in full. Give me a ranked list of the top opportunities and problems, with a specific recommended action for each. Start with anything that looks broken (missing tracking, weak Quality Score, tagging gaps).';

// ---------------------------------------------------------------------------
// Plan synthesis — non-streaming, structured JSON output
//
// Consumes the full conversation transcript + all card-scoped side-threads,
// asks one model to consolidate into a deduped dependency-ordered action
// plan. Returns { plan: {...}, usage: {...}, rawResponse: string, model }.
// Each step is tagged with a `type` so the UI can offer the right
// affordance (Apply for google_ads_action, Copy for app_code_change, etc).
// ---------------------------------------------------------------------------

const PLAN_SYSTEM_PROMPT = `You are consolidating a discussion between a marketing team and one or more AI advisors into a single actionable plan for a Google Ads / mobile-app campaign.

Your job: read the discussion transcript, merge overlapping recommendations, drop rejected or superseded ideas, order remaining actions by dependency, and output a JSON action plan.

OUTPUT REQUIREMENTS
- Output valid JSON only. No prose before or after. No code fences.
- The JSON must match this exact schema:

{
  "title": string,                            // short plan title, ≤ 80 chars
  "summary": string,                          // 2-3 sentence overview of what the plan achieves
  "steps": [
    {
      "title": string,                        // short imperative, 5-12 words
      "description": string,                  // 2-4 sentences; cite specific numbers from the discussion when available
      "type": "google_ads_action" | "app_code_change" | "product_change" | "observation" | "schedule" | "other",
      "action_type": string | null,           // for google_ads_action, name the specific mutation, e.g. "set_primary_conversion_action", "add_negative_keywords", "pause_ad_group", "pause_campaign", "set_campaign_budget", "add_excluded_locations". Null otherwise.
      "action_params": object | null,         // parameters for the mutation, e.g. {"campaignId":"123","keywords":["cheap","free"],"matchType":"BROAD"}. Null when not applicable.
      "priority": "high" | "medium" | "low",
      "effort": string                        // rough estimate: "5min", "30min", "1h", "developer-1d", "product-1w"
    }
  ]
}

RULES
- Order by DEPENDENCY: fixes that unblock other work go first (e.g. broken conversion tracking must be fixed before optimizing bids on it).
- 5–15 steps is ideal; more than that is checklist fatigue.
- Merge overlapping recommendations. If both providers suggested "raise budget", make it ONE step.
- Drop meta advice ("iterate quickly", "monitor carefully"). Only concrete actions.
- If a recommendation was rejected or superseded later in the discussion, drop it entirely.
- For each step, cite specific numbers from the discussion when possible ("Add negatives with combined spend of $47", not "Add some negatives").
- \`action_type\` and \`action_params\` should only be populated for type="google_ads_action". Leave them null for everything else — even if you know the mutation name.`;

async function synthesizePlan({ provider, report, transcript }) {
  const providerKey = provider === 'openai' ? 'openai' : 'claude';
  const t0 = Date.now();

  const userPrompt = `DISCUSSION TRANSCRIPT (chronological):
${transcript}

Produce the JSON action plan now.`;

  if (providerKey === 'openai') {
    return await synthesizePlanOpenAI({ report, systemPrompt: PLAN_SYSTEM_PROMPT, userPrompt, t0 });
  }
  return await synthesizePlanClaude({ report, systemPrompt: PLAN_SYSTEM_PROMPT, userPrompt, t0 });
}

async function synthesizePlanOpenAI({ report, systemPrompt, userPrompt, t0 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  // Include the report as a system-prompt suffix so the model can reference
  // specific numbers if the transcript alludes to them without stating.
  const fullSystem = `${systemPrompt}\n\n--- CAMPAIGN DATA (for numeric citations) ---\n${JSON.stringify(report)}\n--- END CAMPAIGN DATA ---`;

  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: fullSystem },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 4000,
  };

  const resp = await axios.post(OPENAI_URL, body, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 180_000,
  });

  const raw = resp.data?.choices?.[0]?.message?.content || '';
  const usage = resp.data?.usage || {};
  const modelUsed = resp.data?.model || OPENAI_MODEL;
  const cachedPromptTokens = usage.prompt_tokens_details?.cached_tokens || 0;
  const costUsd = costOpenAI(modelUsed, {
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    cachedPromptTokens,
  });

  return {
    plan: safeParsePlan(raw),
    rawResponse: raw,
    model: modelUsed,
    provider: 'openai',
    usage: {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      cacheReadTokens: cachedPromptTokens,
      cacheWriteTokens: 0,
      costUsd,
    },
    durationMs: Date.now() - t0,
  };
}

async function synthesizePlanClaude({ report, systemPrompt, userPrompt, t0 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  // Two-part system: instructions + cached campaign data block.
  const system = [
    { type: 'text', text: systemPrompt },
    {
      type: 'text',
      text: `--- CAMPAIGN DATA (for numeric citations) ---\n${JSON.stringify(report)}\n--- END CAMPAIGN DATA ---`,
      cache_control: { type: 'ephemeral' },
    },
  ];

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.3,
  };

  const resp = await axios.post(ANTHROPIC_URL, body, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    timeout: 180_000,
  });

  const raw = resp.data?.content?.[0]?.text || '';
  const modelUsed = resp.data?.model || CLAUDE_MODEL;
  const inputTokens = resp.data?.usage?.input_tokens || 0;
  const outputTokens = resp.data?.usage?.output_tokens || 0;
  const cacheRead = resp.data?.usage?.cache_read_input_tokens || 0;
  const cacheWrite = resp.data?.usage?.cache_creation_input_tokens || 0;
  const costUsd = costClaude(modelUsed, {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    cacheRead,
    cacheWrite,
  });

  return {
    plan: safeParsePlan(raw),
    rawResponse: raw,
    model: modelUsed,
    provider: 'claude',
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd,
    },
    durationMs: Date.now() - t0,
  };
}

// Tolerant JSON parse — models occasionally wrap in code fences or leading
// prose despite instructions. Extracts first {...} block and parses.
function safeParsePlan(text) {
  if (!text) throw new Error('Empty plan response');
  let trimmed = String(text).trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) trimmed = fence[1].trim();
  try {
    const parsed = JSON.parse(trimmed);
    return validatePlanShape(parsed);
  } catch (_) { /* fall through */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const slice = trimmed.slice(start, end + 1);
    return validatePlanShape(JSON.parse(slice));
  }
  throw new Error('Could not parse plan JSON from model response');
}

function validatePlanShape(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Plan JSON is not an object');
  if (!Array.isArray(obj.steps)) throw new Error('Plan JSON is missing "steps" array');
  const knownTypes = new Set(['google_ads_action', 'app_code_change', 'product_change', 'observation', 'schedule', 'other']);
  const knownPriority = new Set(['high', 'medium', 'low']);
  obj.title = String(obj.title || '').slice(0, 255);
  obj.summary = String(obj.summary || '');
  obj.steps = obj.steps
    .filter(s => s && typeof s === 'object' && s.title)
    .map(s => ({
      title: String(s.title).slice(0, 500),
      description: String(s.description || ''),
      type: knownTypes.has(s.type) ? s.type : 'other',
      action_type: s.action_type ? String(s.action_type).slice(0, 64) : null,
      action_params: s.action_params && typeof s.action_params === 'object' ? s.action_params : null,
      priority: knownPriority.has(s.priority) ? s.priority : 'medium',
      effort: s.effort ? String(s.effort).slice(0, 32) : null,
    }));
  return obj;
}

module.exports = {
  streamOpenAI,
  streamClaude,
  messagesForProvider,
  synthesizePlan,
  OPENAI_MODEL,
  CLAUDE_MODEL,
  INITIAL_ANALYSIS_PROMPT,
  _internal: { costOpenAI, costClaude, buildOpenAiSystemContent, buildClaudeSystemArray, safeParsePlan },
};
