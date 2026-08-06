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

How to respond:
- Ground every recommendation in a specific number from the data. Cite the exact value ("Search term 'roof repair tampa' spent $47 with 0 conversions").
- If tracking or tagging looks broken (missing primary conversion action, low click-to-session rate, weak Quality Score, high install → 0 first_open drop-off on Firebase), call it out FIRST — those block everything else.
- Rank recommendations by estimated impact. Give a rough impact estimate ("could reduce wasted spend by ~$X/mo", "could add ~Y conversions/mo").
- For keyword/negative/audience lists, use short bullet lists.
- If the data does not contain enough signal to answer a follow-up question, say so plainly. Do not invent numbers.
- Respond in markdown.`;

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

// ---------------------------------------------------------------------------
// OpenAI streaming
// ---------------------------------------------------------------------------
async function streamOpenAI({ report, messages, onDelta, onComplete, onError }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    onError(new Error('OPENAI_API_KEY is not configured'));
    return;
  }

  const body = {
    model: OPENAI_MODEL,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: buildOpenAiSystemContent(report) },
      ...messages,
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
async function streamClaude({ report, messages, onDelta, onComplete, onError }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    onError(new Error('ANTHROPIC_API_KEY is not configured'));
    return;
  }

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    stream: true,
    system: buildClaudeSystemArray(report),
    messages,
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

module.exports = {
  streamOpenAI,
  streamClaude,
  messagesForProvider,
  OPENAI_MODEL,
  CLAUDE_MODEL,
  INITIAL_ANALYSIS_PROMPT,
  _internal: { costOpenAI, costClaude, buildOpenAiSystemContent, buildClaudeSystemArray },
};
