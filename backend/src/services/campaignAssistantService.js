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
const { safeParseMonitorSpec } = require('./campaignMonitorService');

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

// Extra system-instruction block that teaches the model how to reason about
// Meta Ads data + attribution + the provider-tagged alerts array — everything
// the report shape assumes but the model can't infer from field names.
// Kept as a separate constant so it's easy to audit and test.
const META_INSTRUCTIONS = `

--- META ADS SEMANTICS + ATTRIBUTION GUARDRAILS (CRITICAL) ---

The report may include a Meta Ads section under \`metaAds\`, cross-channel data under \`summary.channels\`, provider-tagged alerts under \`alertsByProvider\`, and Meta ↔ GA4 attribution under \`crossReference.metaByCampaign\` + \`crossReference.metaAttribution\`. When present, follow these rules exactly.

METRIC SEMANTICS — DO NOT CONFLATE:
- Google Ads "conversion" ≠ Meta "result" ≠ GA4 "key event". Each provider's \`conversionDefinition\` string in \`summary.channels.<provider>.conversionDefinition\` is authoritative. Cite it verbatim when the user asks how two are related.
- Meta results are objective-dependent. \`metaAds.resultsByObjective\` is an ARRAY of buckets, each with an \`objective\` + \`actionType\` (e.g. OUTCOME_LEADS→lead, OUTCOME_SALES→purchase, MESSAGES→onsite_conversion.messaging_conversation_started_7d, REACH→reach). NEVER sum results across incompatible action types into a fake universal "conversion" count.
- Cost-per-result comparisons are only valid within the SAME objective/actionType bucket. Comparing lead CPA to purchase CPA (or across accounts with different objectives) is nonsense — say so if the user tries.

ATTRIBUTION QUALITY — \`crossReference.metaAttribution.quality\`:
Use this as an explicit reasoning constraint. The value is one of:
- "campaign"       → high-confidence campaign-level Meta↔GA4 matches exist in \`crossReference.metaByCampaign\`. You MAY draw campaign-level conclusions for those matched records only.
- "partial"        → some campaigns match cleanly, some don't. Draw campaign-level conclusions ONLY for records present in \`metaByCampaign\`. For unmatched campaigns listed in \`crossReference.metaAttribution.unmatchedMetaCampaigns\`, treat Meta and GA4 as independent — do NOT claim any specific campaign caused any specific session/conversion.
- "channel"        → no reliable campaign-level joining. GA4 shows some Meta-attributable traffic (see \`channelRollup\`), but you MAY NOT say "campaign X caused Y GA4 conversions." Talk about Meta at the platform level and GA4 at the platform level — never link a specific Meta campaign to specific GA4 downstream outcomes.
- "none"           → no campaign-level match AND no Meta-attributable GA4 traffic. Discuss Meta API performance and GA4 website performance as independent data sets. Do not imply causal attribution.
- "not_requested"  → attribution wasn't evaluated. Do not mention attribution as though it was.

BUDGET-ALLOCATION QUESTIONS (e.g. "should I move budget from Google to Meta?"):
- When quality is "campaign" AND matched records include cost-per-conversion and cost-per-result that correspond to the SAME business event (established by \`conversionDefinition\` equivalence), you may recommend a specific reallocation with numbers.
- When quality is "channel" or "none", you MUST explain that:
  * Platform-side efficiency (Meta CPM/CTR/CPC vs Google CPM/CTR/CPC) can be compared directly with their definitions
  * Provider-native result metrics can be compared with their definitions
  * VERIFIED downstream campaign-level BUSINESS OUTCOMES cannot be compared
  You may recommend an experiment (e.g. "run a small Meta test with UTM-tagged links to establish attribution") or a tracking improvement. You may NOT say "move exactly 30% of Google budget to Meta because it produces cheaper customers" — the data does not establish comparable customer outcomes.

DIAGNOSTIC-LANGUAGE RULES — \`alertsByProvider\` where \`provider === 'meta_ads'\`:
Each Meta alert carries a \`source\` field:
- source: "meta"     → Meta itself reported this issue (e.g. delivery issues_info). Language MUST attribute it to Meta directly. Example: "Meta reports this ad cannot deliver because the payment method is invalid" — NOT "we think this ad has a payment issue." Preserve Meta's returned wording verbatim when useful.
- source: "computed" → Post-To derived this from transparent metrics (high frequency, low CTR, no-result spend, CPA outlier, etc.). Language MUST attribute it to Post-To. Example: "Post-To detects this ad's frequency is 5.2× per user, above the 4× threshold where CTR typically drops" — NOT "Meta says this ad has ad fatigue."
Never phrase a "computed" diagnostic as if Meta made the recommendation.

PROVIDER AVAILABILITY:
- \`metaAds === null\` → Meta was not requested / not connected for this account. Missing Meta data means UNKNOWN, not zero performance. Do not conclude "your Meta ads are underperforming" from absence.
- \`metaAds\` present but every Meta section in \`errors\` array with \`section: 'meta.*'\` → Meta API failed. Say "Meta data is temporarily unavailable — the report includes Google Ads / GA4 but cannot show Meta performance in this window."
- If a Meta alert has type \`meta_delivery_issue\` mentioning ads_read or permission errors → the token lacks Ads reporting permission. Direct the user to Connections to reconnect Meta.

READ-ONLY — MOST IMPORTANT RULE:
Phase 1E of the Meta integration is READ-ONLY. When you recommend a Meta action (e.g. "pause this ad", "raise this ad set's budget", "boost this post"), your recommendation MUST be prose or an "observation" step — NEVER an executable action step. There is no \`meta_ads_action\` type in this system. The Google Ads apply flow does not extend to Meta. Do NOT emit action_type values like "pause_meta_ad", "set_meta_adset_budget", "boost_post", or anything else that a Meta mutation dispatcher would consume. Meta mutations are Phase 2 and require separate Meta App Review for the ads_management permission.
--- END META ADS SEMANTICS + ATTRIBUTION GUARDRAILS ---
`;

const SYSTEM_PREAMBLE_TEMPLATE = ({ campaignName, days }) => `You are a senior paid-search and paid-social strategist for a local service business. Your job is to review a full account snapshot (Google Ads campaigns, Meta/Facebook/Instagram ads when connected, GA4 sessions and conversions, Firebase app events when present, and prior OpenAI Ads spend and creative history) and give sharp, actionable recommendations to improve ${campaignName ? `the "${campaignName}" campaign` : 'the selected campaign'} over the next ${days || 30} days.

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

For follow-up questions (not the initial analysis), if the user asks something conversational ("why is CTR dropping?", "explain X"), you may respond as plain markdown without the ## Fix format. The ## Fix format is for issue lists only.${META_INSTRUCTIONS}`;

// Guidance for when to prefer live tools over the snapshot. Only appended
// when tools are actually wired for this turn (otherwise it's misleading).
// Kept short — the tool descriptions themselves carry the "when to use"
// language; this block just tells the model tools EXIST and warns against
// overuse. Every tool call = extra latency + tokens.
const TOOL_USAGE_INSTRUCTIONS = `
--- LIVE DATA TOOLS AVAILABLE ---
Use these read-only tools when the user asks about CURRENT state that the snapshot cannot answer. Prefer ONE targeted tool call over a chain; never chain more than 3 in a single turn.

GOOGLE ADS
- "check ad 12345", "is ad X running", "why isn't Y delivering" → google_ads_get_ad_status
- "what changed today", "did anything change recently" → google_ads_get_recent_changes
- "what's wrong right now", "any current issues" → google_ads_get_diagnostics
- "which ads are running", "any disapproved ads" → google_ads_list_ads
- "current campaign metrics", "how is campaign X doing now" → google_ads_get_campaign
- "any bad search terms", "what's eating my budget lately" → google_ads_get_search_terms

APPLE APP STORE (iOS app funnel + reviews)
- "how does my App Store listing convert?", "install conversion rate" → asc_get_install_funnel
- "paid vs organic installs", "which source drives installs?" → asc_get_installs_by_source
- "any bad reviews?", "what are users complaining about?" → asc_get_recent_reviews

CROSS-PROVIDER REASONING is where these tools shine:
- "is my Google Ads spend actually driving iOS installs?" → call BOTH google_ads_get_campaign (paid cost) AND asc_get_installs_by_source (see if Web Referrer / Campaign source rose with spend). If ASC shows organic (App Store Search / Browse) unchanged while paid rose, ads likely brand-lifted rather than net-new-driven.
- "should I pause this campaign?" → look at both the Google Ads metrics (CPC, conversions) AND the ASC install data for the same window. Cite ratios (e.g. "$5 Google Ads cost per Web Referrer install") but only when both tools agree on the window.

WHEN TO SKIP TOOLS: historical trend already in snapshot; brand/creative advice; questions about the AI itself.
--- END LIVE DATA TOOLS ---`;

function buildOpenAiSystemContent(report, planProgress, { hasTools = false } = {}) {
  const preamble = SYSTEM_PREAMBLE_TEMPLATE({
    campaignName: report?.account?.descriptiveName || null,
    days: report?.meta?.dateRangeDays,
  });
  const parts = [
    preamble,
    `--- BEGIN CAMPAIGN DATA (JSON) ---\n${JSON.stringify(report)}\n--- END CAMPAIGN DATA ---`,
  ];
  // Plan-progress block goes at the END so it doesn't invalidate the
  // OpenAI auto-cache on the (unchanging) report prefix. Changes every
  // time the user checks off a step, so it MUST be outside cached region.
  if (planProgress) {
    parts.push(planProgress);
  }
  if (hasTools) {
    parts.push(TOOL_USAGE_INSTRUCTIONS);
  }
  return parts.join('\n\n');
}

function buildClaudeSystemArray(report, planProgress, { hasTools = false } = {}) {
  const preamble = SYSTEM_PREAMBLE_TEMPLATE({
    campaignName: report?.account?.descriptiveName || null,
    days: report?.meta?.dateRangeDays,
  });
  // Two-part system so the (large, stable) report JSON gets its own cache
  // breakpoint. Follow-up turns re-send the same prefix → cache hit → ~10%
  // of full input cost.
  const parts = [
    { type: 'text', text: preamble },
    {
      type: 'text',
      text: `--- BEGIN CAMPAIGN DATA (JSON) ---\n${JSON.stringify(report)}\n--- END CAMPAIGN DATA ---`,
      cache_control: { type: 'ephemeral' },
    },
  ];
  // Plan-progress block appended AFTER the cache breakpoint. Anthropic's
  // ephemeral cache only covers the marked block and everything before it,
  // so parts after can change every turn without invalidating cache.
  if (planProgress) {
    parts.push({ type: 'text', text: planProgress });
  }
  if (hasTools) {
    parts.push({ type: 'text', text: TOOL_USAGE_INSTRUCTIONS });
  }
  return parts;
}

// Format a compact "plan progress" system-prompt block so the AI knows
// which steps the user has already checked off, applied, or skipped.
// Prevents suggestions for things already done in follow-up chat turns.
// Returns null when there's no plan or no steps to report.
function buildPlanProgressBlock(plan, steps) {
  if (!plan || !Array.isArray(steps) || steps.length === 0) return null;
  const symbol = (s) => {
    if (s === 'done' || s === 'applied') return '✓';
    if (s === 'failed') return '✗';
    if (s === 'skipped') return '−';
    return '☐';
  };
  const lines = [];
  steps.forEach((s, i) => {
    const num = String(i + 1).padStart(2, ' ');
    const sym = symbol(s.status);
    const status = s.status || 'pending';
    lines.push(`${sym} ${num}. ${s.title} — ${status}`);
    // Include user notes (esp. "push-back" reasons on skipped steps) so
    // the AI sees WHY something was rejected, not just that it was.
    if (s.notes && String(s.notes).trim()) {
      const noteText = String(s.notes).trim().replace(/\n+/g, ' ').slice(0, 800);
      lines.push(`     Note: "${noteText}"`);
    }
  });
  return `--- PLAN PROGRESS (current step statuses + user notes/rejections — respect these; do NOT re-recommend things already done, applied, or explicitly rejected by the user) ---
Plan: ${plan.title || '(untitled)'}
Legend: ✓ done/applied · ☐ pending · − skipped (user rejected) · ✗ failed

${lines.join('\n')}
--- END PLAN PROGRESS ---`;
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
// Tool-use loop (both providers)
// ---------------------------------------------------------------------------
// The `tools` + `toolExecutor` params are optional. When absent, both stream
// functions behave exactly as before: single round, stream text deltas,
// call onComplete. When present, the stream loops: if the model returns
// tool_calls (OpenAI) or tool_use blocks (Claude), we execute each tool,
// append the results as new messages, and re-invoke the model. Loop caps
// at MAX_TOOL_ROUNDS to bound cost.
//
// onToolCall({ tool, args, roundIndex }) fires as soon as we have a
// finalized tool call ready to execute — the route uses this to emit an
// SSE frame ("Checking ad status…") so the UI can show progress.

const MAX_TOOL_ROUNDS = 5;

// Drain a Node readable stream into a UTF-8 string. Used to capture the
// error body when axios responds with a 4xx to a streaming request —
// otherwise we lose the provider's actual error message and are stuck
// with "Request failed with status code 400".
async function drainStreamToString(stream, maxBytes = 8192) {
  let out = '';
  for await (const chunk of stream) {
    out += chunk.toString('utf8');
    if (out.length >= maxBytes) return out.slice(0, maxBytes);
  }
  return out;
}

// Run a single OpenAI streaming completion round. Returns everything we
// need to decide whether to loop again: accumulated text, structured tool
// calls, and usage. Streams text deltas through onDelta as they arrive so
// the UX doesn't wait for the round to end.
function runOpenAiRound({ apiKey, body, onDelta }) {
  return new Promise(async (resolve, reject) => {
    let resp;
    try {
      resp = await axios.post(OPENAI_URL, body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        // Never throw on status — we drain the body ourselves so we can
        // surface OpenAI's actual error text instead of "status code 400".
        validateStatus: () => true,
        timeout: 180_000,
      });
    } catch (err) {
      reject(err);
      return;
    }

    if (resp.status >= 400) {
      const errBody = await drainStreamToString(resp.data).catch(() => '');
      reject(Object.assign(
        new Error(`OpenAI ${resp.status}: ${errBody || '(no body)'}`),
        { status: resp.status, body: errBody }
      ));
      return;
    }

    let acc = '';
    let usage = null;
    let modelUsed = body.model;
    let finishReason = null;
    // Tool calls stream in as {index, id?, function: {name?, arguments?}} — we
    // reassemble them by their index because arguments come as a JSON string
    // spread across many deltas.
    const toolCalls = [];
    let buf = '';
    let settled = false;

    const settle = (val, err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(val);
    };

    resp.data.on('data', chunk => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const raw of parts) {
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const choice = j.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            acc += delta.content;
            try { onDelta(delta.content); } catch (_) { /* delta handler must not kill stream */ }
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', args: '' };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (typeof tc.function?.arguments === 'string') {
                toolCalls[idx].args += tc.function.arguments;
              }
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (j.usage) usage = j.usage;
          if (j.model) modelUsed = j.model;
        } catch (_) { /* ignore malformed frames */ }
      }
    });

    resp.data.on('end', () => {
      settle({
        content: acc,
        toolCalls: toolCalls.filter(c => c && c.id && c.name),
        usage,
        modelUsed,
        finishReason,
      });
    });

    resp.data.on('error', err => settle(null, err));
  });
}

// ---------------------------------------------------------------------------
// OpenAI streaming (with optional tool-use loop)
// ---------------------------------------------------------------------------
async function streamOpenAI({
  report, messages, attachments, planProgress,
  tools, toolExecutor,
  onDelta, onToolCall, onComplete, onError,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    onError(new Error('OPENAI_API_KEY is not configured'));
    return;
  }

  const attach = normalizeAttachments(attachments);
  // Attachments only travel on the FIRST user message; on tool follow-up
  // rounds the working messages array grows with assistant/tool messages
  // — attaching images to those would be nonsensical.
  const workingMessages = withAttachmentsOpenAI(messages, attach).slice();

  const wantTools = Array.isArray(tools) && tools.length > 0 && toolExecutor;
  const totals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  let finalContent = '';
  let modelUsed = OPENAI_MODEL;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const body = {
        model: OPENAI_MODEL,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: buildOpenAiSystemContent(report, planProgress, { hasTools: wantTools }) },
          ...workingMessages,
        ],
        temperature: 0.5,
      };
      if (wantTools) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const roundResult = await runOpenAiRound({ apiKey, body, onDelta });
      modelUsed = roundResult.modelUsed || modelUsed;
      finalContent += roundResult.content || '';
      const u = roundResult.usage || {};
      totals.promptTokens += u.prompt_tokens || 0;
      totals.completionTokens += u.completion_tokens || 0;
      totals.cachedTokens += u.prompt_tokens_details?.cached_tokens || 0;

      const needsTools = wantTools
        && roundResult.finishReason === 'tool_calls'
        && roundResult.toolCalls.length > 0;

      if (!needsTools) {
        const costUsd = costOpenAI(modelUsed, {
          promptTokens: totals.promptTokens,
          completionTokens: totals.completionTokens,
          cachedPromptTokens: totals.cachedTokens,
        });
        onComplete({
          provider: 'openai',
          model: modelUsed,
          content: finalContent,
          promptTokens: totals.promptTokens,
          completionTokens: totals.completionTokens,
          cacheReadTokens: totals.cachedTokens,
          cacheWriteTokens: 0,
          totalTokens: totals.promptTokens + totals.completionTokens,
          costUsd,
        });
        return;
      }

      // Push the assistant's tool-call message onto the working history.
      workingMessages.push({
        role: 'assistant',
        content: roundResult.content || null,
        tool_calls: roundResult.toolCalls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        })),
      });

      // Execute each tool sequentially and append tool_result messages.
      for (const call of roundResult.toolCalls) {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(call.args || '{}'); } catch { parsedArgs = {}; }
        try { onToolCall?.({ tool: call.name, args: parsedArgs, roundIndex: round }); } catch { /* ignore */ }
        let result;
        try {
          result = await toolExecutor.execute(call.name, parsedArgs);
        } catch (e) {
          result = { error: String(e?.message || 'tool execution failed').slice(0, 1000) };
        }
        workingMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          // Cap tool result size to avoid pushing the context window over.
          content: JSON.stringify(result).slice(0, 60_000),
        });
      }
    }

    // Hit MAX_TOOL_ROUNDS without a stop — return what we have so the user
    // still gets a message rather than nothing.
    const costUsd = costOpenAI(modelUsed, {
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      cachedPromptTokens: totals.cachedTokens,
    });
    onComplete({
      provider: 'openai',
      model: modelUsed,
      content: finalContent || '[Tool loop hit the maximum iteration limit without a final answer.]',
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      cacheReadTokens: totals.cachedTokens,
      cacheWriteTokens: 0,
      totalTokens: totals.promptTokens + totals.completionTokens,
      costUsd,
    });
  } catch (err) {
    onError(err);
  }
}

// Run a single Claude streaming round. Content blocks stream in as text
// (text_delta) or tool_use (input_json_delta). We reassemble tool_use
// blocks so we can execute them after the round ends.
function runClaudeRound({ apiKey, body, onDelta }) {
  return new Promise(async (resolve, reject) => {
    let resp;
    try {
      resp = await axios.post(ANTHROPIC_URL, body, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        validateStatus: () => true,
        timeout: 180_000,
      });
    } catch (err) {
      reject(err);
      return;
    }

    if (resp.status >= 400) {
      const errBody = await drainStreamToString(resp.data).catch(() => '');
      reject(Object.assign(
        new Error(`Anthropic ${resp.status}: ${errBody || '(no body)'}`),
        { status: resp.status, body: errBody }
      ));
      return;
    }

    let acc = '';
    let modelUsed = body.model;
    let stopReason = null;
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    // blocks[index] = { type, text?, tool_use_id?, name?, inputJson? }
    const blocks = [];
    // Preserve the message-order of content blocks for the assistant echo
    // Anthropic requires when we send back tool_result.
    let buf = '';
    let settled = false;

    const settle = (val, err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(val);
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
          if (j.type === 'message_start' && j.message) {
            if (j.message.model) modelUsed = j.message.model;
            if (j.message.usage) {
              usage.input_tokens = j.message.usage.input_tokens || 0;
              usage.cache_read_input_tokens = j.message.usage.cache_read_input_tokens || 0;
              usage.cache_creation_input_tokens = j.message.usage.cache_creation_input_tokens || 0;
            }
          } else if (j.type === 'content_block_start' && j.content_block) {
            const idx = typeof j.index === 'number' ? j.index : blocks.length;
            if (j.content_block.type === 'text') {
              blocks[idx] = { type: 'text', text: '' };
            } else if (j.content_block.type === 'tool_use') {
              blocks[idx] = {
                type: 'tool_use',
                id: j.content_block.id,
                name: j.content_block.name,
                inputJson: '',
              };
            }
          } else if (j.type === 'content_block_delta') {
            const idx = typeof j.index === 'number' ? j.index : 0;
            const block = blocks[idx];
            if (!block) continue;
            if (j.delta?.type === 'text_delta' && block.type === 'text') {
              block.text += j.delta.text || '';
              acc += j.delta.text || '';
              try { onDelta(j.delta.text || ''); } catch (_) { /* ignore */ }
            } else if (j.delta?.type === 'input_json_delta' && block.type === 'tool_use') {
              block.inputJson += j.delta.partial_json || '';
            }
          } else if (j.type === 'message_delta') {
            if (j.usage) usage.output_tokens = j.usage.output_tokens || 0;
            if (j.delta?.stop_reason) stopReason = j.delta.stop_reason;
          }
        } catch (_) { /* ignore malformed frames */ }
      }
    });

    resp.data.on('end', () => {
      settle({
        acc,
        blocks: blocks.filter(Boolean),
        usage,
        modelUsed,
        stopReason,
      });
    });

    resp.data.on('error', err => settle(null, err));
  });
}

// ---------------------------------------------------------------------------
// Claude (Anthropic) streaming (with optional tool-use loop)
// ---------------------------------------------------------------------------
async function streamClaude({
  report, messages, attachments, planProgress,
  tools, toolExecutor,
  onDelta, onToolCall, onComplete, onError,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    onError(new Error('ANTHROPIC_API_KEY is not configured'));
    return;
  }

  const attach = normalizeAttachments(attachments);
  const workingMessages = withAttachmentsClaude(messages, attach).slice();

  const wantTools = Array.isArray(tools) && tools.length > 0 && toolExecutor;
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let finalContent = '';
  let modelUsed = CLAUDE_MODEL;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const body = {
        model: CLAUDE_MODEL,
        max_tokens: 4000,
        stream: true,
        system: buildClaudeSystemArray(report, planProgress, { hasTools: wantTools }),
        messages: workingMessages,
        temperature: 0.5,
      };
      if (wantTools) body.tools = tools;

      const roundResult = await runClaudeRound({ apiKey, body, onDelta });
      modelUsed = roundResult.modelUsed || modelUsed;
      finalContent += roundResult.acc || '';
      const u = roundResult.usage || {};
      totals.input_tokens += u.input_tokens || 0;
      totals.output_tokens += u.output_tokens || 0;
      totals.cache_read_input_tokens += u.cache_read_input_tokens || 0;
      totals.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;

      const toolBlocks = roundResult.blocks.filter(b => b.type === 'tool_use');
      const needsTools = wantTools
        && roundResult.stopReason === 'tool_use'
        && toolBlocks.length > 0;

      if (!needsTools) {
        const costUsd = costClaude(modelUsed, {
          promptTokens: totals.input_tokens,
          completionTokens: totals.output_tokens,
          cacheRead: totals.cache_read_input_tokens,
          cacheWrite: totals.cache_creation_input_tokens,
        });
        onComplete({
          provider: 'claude',
          model: modelUsed,
          content: finalContent,
          promptTokens: totals.input_tokens,
          completionTokens: totals.output_tokens,
          cacheReadTokens: totals.cache_read_input_tokens,
          cacheWriteTokens: totals.cache_creation_input_tokens,
          totalTokens: totals.input_tokens + totals.output_tokens,
          costUsd,
        });
        return;
      }

      // Echo the assistant's full content array back — Anthropic requires
      // this structure when responding with tool_result blocks. Empty text
      // blocks (Claude occasionally streams a text placeholder that never
      // gets any delta before it switches to tool_use) MUST be filtered
      // out — Anthropic 400s on `{type:'text', text:''}`.
      workingMessages.push({
        role: 'assistant',
        content: roundResult.blocks
          .map(b => {
            if (b.type === 'text') {
              const text = b.text || '';
              return text.length ? { type: 'text', text } : null;
            }
            return {
              type: 'tool_use',
              id: b.id,
              name: b.name,
              input: safeParseObject(b.inputJson),
            };
          })
          .filter(Boolean),
      });

      // Execute each tool, then push a single user message containing every
      // tool_result block (Anthropic's expected shape).
      const toolResultBlocks = [];
      for (const block of toolBlocks) {
        const args = safeParseObject(block.inputJson);
        try { onToolCall?.({ tool: block.name, args, roundIndex: round }); } catch { /* ignore */ }
        let result;
        try {
          result = await toolExecutor.execute(block.name, args);
        } catch (e) {
          result = { error: String(e?.message || 'tool execution failed').slice(0, 1000) };
        }
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result).slice(0, 60_000),
        });
      }
      workingMessages.push({ role: 'user', content: toolResultBlocks });
    }

    const costUsd = costClaude(modelUsed, {
      promptTokens: totals.input_tokens,
      completionTokens: totals.output_tokens,
      cacheRead: totals.cache_read_input_tokens,
      cacheWrite: totals.cache_creation_input_tokens,
    });
    onComplete({
      provider: 'claude',
      model: modelUsed,
      content: finalContent || '[Tool loop hit the maximum iteration limit without a final answer.]',
      promptTokens: totals.input_tokens,
      completionTokens: totals.output_tokens,
      cacheReadTokens: totals.cache_read_input_tokens,
      cacheWriteTokens: totals.cache_creation_input_tokens,
      totalTokens: totals.input_tokens + totals.output_tokens,
      costUsd,
    });
  } catch (err) {
    onError(err);
  }
}

function safeParseObject(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
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
      "action_type": string | null,           // see AUTOMATION CATALOG below
      "action_params": object | null,         // params matching the action_type's schema
      "priority": "high" | "medium" | "low",
      "effort": string,                       // rough estimate: "5min", "30min", "1h", "developer-1d", "product-1w"
      "monitor_spec": object | null,          // ONLY for type="observation" — see AUTO-MONITOR CATALOG below
      "check_after": string | null,           // ISO 8601 timestamp; only for observation steps with monitor_spec
      "check_until": string | null            // ISO 8601 timestamp; only for observation steps with monitor_spec
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

RESPECT PRIOR PLAN OUTCOMES — CRITICAL

If the transcript begins with a "=== PRIOR PLAN OUTCOMES ===" block, that block enumerates every step the user has already completed, applied, skipped, or failed across prior plans in this conversation, WITH the notes explaining what happened. You MUST respect it:

- Steps marked "done" or "applied" — do NOT include them in the new plan. The user considers them finished. The only exception is if a prior "applied" step's downstream effect has visibly regressed (e.g. campaign was paused, then unpaused, and metrics have deteriorated again) — in which case briefly acknowledge this in the summary and include the re-do as a step.
- Steps marked "skipped" — respect the note explaining why. If the reason was "user rejected: [reason]" (see the note field), DO NOT re-propose the same task under a different name. If the reason indicates a temporary block ("waiting on data"), you may include a follow-up step that assumes the block has cleared.
- Steps marked "failed" — you MAY include a modified version if the failure reason (in the note) suggests a different approach could work.
- If a step's note contains "[RESULTS ... AI action: close]" with a note like "User reported: [dev agent explaining the task was misframed, offering alternatives]", the ORIGINAL task is done AND you should consider whether the ALTERNATIVES the agent offered still need to be captured as new steps.
- If a step's note contains "[Carried forward from previous plan]", treat its status as authoritative — the user's earlier work is preserved.

HARD DEDUP RULE — final check before you output the plan.

For every step you're about to include, ask yourself: "does this substantively duplicate any OUTCOMES entry?" — where "substantively duplicate" means SAME core action + SAME object, even if paraphrased.

Examples of the SAME task (must NOT be re-proposed if any variant appears in OUTCOMES):
- "Cap job reminder prompt at 2 impressions per user" ≈ "Cap job reminder prompt at N per user" ≈ "Limit job reminder to 2 impressions" ≈ "Cap scheduled job-reminder pushes per user per 24h"
- "Fix ATT consent prompt timing" ≈ "Move ATT prompt to after first_photo_taken" ≈ "Rework when ATT prompt fires"
- "Add attribution_captured event at UTM extraction" ≈ "Implement attribution_captured logging" ≈ "Instrument UTM capture at install"
- "Verify geo-targeting is PRESENCE only" ≈ "Set positive geo-target to PRESENCE" ≈ "Confirm campaign geo mode"

If a would-be step matches ANY of these patterns against the OUTCOMES block, drop it entirely — OR only include it if it's a genuinely NEW follow-up action (e.g. "the cap is live per prior plan; A/B test 2 vs 3 as the cap value" — that's follow-up, not re-do).

Do this dedup pass silently — no need to mention it in the plan summary — but treat it as a hard bug if you emit a duplicate.

RESPECT CURRENT STATE — CRITICAL

Before recommending ANY change to ANY setting or statistic, check the current value in the campaign snapshot. If the change you'd recommend is already in effect (or effectively so), DO NOT include that as a step. The user is planning what to do NEXT, not re-doing what's already been done. This applies to EVERY recommendation — not just campaign status. Concretely:

- Look up the current value in the snapshot before proposing a change. If it already matches your target (within a sensible tolerance where the field is numeric), drop the step.
- If the state has been fixed but the underlying diagnosis is still valid (e.g. campaign is paused BUT the tracking issue that caused you to want it paused is still present), keep the fix step, drop the state-change step.
- Applies to: campaign status (PAUSED/ENABLED), primary conversion action, campaign budget, bidding strategy, geo targeting, ad schedule, negative keywords (skip keywords already in the negative list), GA4 conversion event marking, Remote Config parameter values, and anything else the snapshot exposes.

Specific examples (not exhaustive):
- If campaign.status == "PAUSED" in the snapshot → DO NOT recommend pause_campaign. The user has already paused it. If your concern is still valid (e.g. tracking is still broken), keep the tracking fix, drop the pause step.
- If campaign.status == "ENABLED" but you'd otherwise recommend pausing, that's fine — the pause hasn't happened yet.
- If a conversion action's primary_for_goal == true and matches your recommended primary → DO NOT recommend set_primary_conversion_action for it.
- If daily budget matches (within 5%) your recommendation → DO NOT recommend set_campaign_budget.
- If a keyword you'd add as a negative is already in the negatives list → drop it from the keywords array (or drop the whole step if none remain).
- If a GA4 event already has isConversion == true → DO NOT recommend mark_ga4_conversion_event for it.
- If Remote Config parameter is already at your recommended value → DO NOT recommend set_remote_config_parameter.

You may still MENTION the current state in your summary or in another step's description as context ("the campaign is currently paused, so before unpausing, fix these tracking issues first"). What you must NOT do is create a step whose entire purpose is to make state or a value be what it already is.

If checking the current value is not possible from the snapshot data provided (rare — the snapshot is comprehensive), you MAY still include the recommendation but flag the uncertainty in the description ("verify current setting before applying").

AUTOMATION CATALOG — one-click apply

When a fix maps to one of the automations below, populate BOTH \`action_type\` and \`action_params\` with the exact schema shown. This flips the step to "one-click applyable" in the user's UI. When no automation applies, leave both fields null.

WIRED (user can apply immediately with our infrastructure):
- type: "google_ads_action", action_type: "add_negative_keywords"
    action_params: { "campaignId": "<numeric>", "keywords": ["cheap","free","tutorial"], "matchType": "BROAD" | "PHRASE" | "EXACT" }
    Notes: adds negatives at CAMPAIGN scope. Fully reversible in Google Ads UI → Keywords → Negatives.
- type: "google_ads_action", action_type: "pause_campaign"
    action_params: { "campaignId": "<numeric>" }
- type: "google_ads_action", action_type: "enable_campaign"
    action_params: { "campaignId": "<numeric>" }
    Notes: for "unpause" / "resume campaign" recommendations. Only use when campaign.status is PAUSED and you're recommending it should be ENABLED.
- type: "google_ads_action", action_type: "set_campaign_budget"
    action_params: { "campaignId": "<numeric>", "dailyBudgetUsd": <number> }
    Notes: refuses to change SHARED budgets (would affect other campaigns).
- type: "google_ads_action", action_type: "set_primary_conversion_action"
    action_params: { "campaignId": "<numeric>", "conversionActionResourceName": "customers/<cid>/conversionActions/<actionId>" }
    Notes: applies at ACCOUNT level (affects every campaign not overriding via campaign_conversion_goal).
- type: "google_ads_action", action_type: "set_geo_target_type"
    action_params: { "campaignId": "<numeric>", "positiveType": "PRESENCE" | "PRESENCE_OR_INTEREST" | "SEARCH_INTEREST" | "DONT_CARE" }
    Notes: recommend PRESENCE when GA4 shows traffic from cities outside the campaign target country (indicates PRESENCE_OR_INTEREST leak).
- type: "google_ads_action", action_type: "add_excluded_locations"
    action_params: { "campaignId": "<numeric>", "locationIds": ["<geo_target_constant_id>", ...] }
    Notes: locationIds are numeric geo_target_constant IDs. Duplicates are rejected but non-fatal.

PLANNED (recognised — use these action_type names so the plan is future-ready even though the button is currently disabled):
- type: "google_ads_action", action_type: "pause_ad_group"
    action_params: { "adGroupId": "<numeric>" }

CONFIG CHANGES (Firebase / GA4 — planned, use these names when suggesting):
- type: "app_code_change", action_type: "mark_ga4_conversion_event"
    action_params: { "propertyId": "<numeric>", "eventName": "subscription_started" }
    Note: this is CONFIG not code (mark existing event as a key event / conversion). Use "app_code_change" type because it changes analytics behaviour, even though no code is edited.
- type: "app_code_change", action_type: "set_remote_config_parameter"
    action_params: { "projectId": "<firebase project id>", "parameterKey": "<string>", "defaultValue": "<string>", "description": "<string>" }

AUTO-MONITOR CATALOG — background metric watching for observation steps

For type="observation" steps, populate \`monitor_spec\` + \`check_after\` + \`check_until\` when the step is "wait N days then check if metric M hit target T." A background job will pull the metric on schedule and auto-mark the step "done" when the target is met, or "failed" when the window closes without a hit. This eliminates the manual re-check burden.

\`check_after\`: earliest ISO timestamp at which checking makes sense. Compute this from the campaign's change history date + expected data-lag (typically 24-48h for GA4 events, 24h for Ads reports). Example: if a config change went live at 2026-08-20T14:00Z and the observation window is "14 days after change", \`check_after\` should be 2026-08-21T14:00Z (first look 24h in).

\`check_until\`: latest ISO timestamp — the deadline. If the target isn't hit by then, the step is marked failed with the last observed value in a note. Compute from change date + full window. Example above: 2026-09-03T14:00Z.

WIRED SOURCES:

- source: "ga4_event_rate" — ratio between two GA4 event counts over a lookback
    params: { "numerator_event": "<event_name>", "denominator_event": "<event_name>", "days": <1-90> }
    threshold: { "op": "<" | "<=" | ">" | ">=" | "==", "value": <number 0..1 for a rate> }
    Example (cancellation rate below 30%): { source: "ga4_event_rate", params: { numerator_event: "purchase_cancelled", denominator_event: "purchase_started", days: 14 }, threshold: { op: "<", value: 0.30 }, target_description: "Cancellation rate drops below 30%" }

- source: "ga4_event_count" — raw event count for a single event over a lookback
    params: { "event_name": "<event_name>", "days": <1-90> }
    threshold: { "op": ">=" | ">" | "<=" | "<" | "==", "value": <integer count> }
    Example (trial_started starts appearing): { source: "ga4_event_count", params: { event_name: "trial_started", days: 2 }, threshold: { op: ">=", value: 5 }, target_description: "trial_started events climbing" }

- source: "google_ads_geo_share" — % of impressions coming from a specific country criterion
    params: { "country_criterion_id": "<numeric ID from geographic_view.country_criterion_id>", "days": <1-90> }
    threshold: { "op": "<" | "<=", "value": <fraction 0..1> }
    Example (Seoul/South Korea traffic drops after geo change): { source: "google_ads_geo_share", params: { country_criterion_id: "2410", days: 7 }, threshold: { op: "<", value: 0.05 }, target_description: "South Korea impression share drops below 5% after PRESENCE-only change" }

RULES for monitor_spec:
- ONLY populate for type="observation". For other types, leave null.
- If the observation isn't measurable via one of the wired sources (e.g. "read the DebugView console qualitatively"), leave monitor_spec null. Manual observation stays manual — don't fake a spec.
- The threshold + target_description MUST match the intent stated in the step description. If the description says "watch for cancellation rate to drop below 30%", the threshold is \`{op: "<", value: 0.30}\` and target_description is "Cancellation rate drops below 30%".
- Compute check_after and check_until from CONCRETE DATES in the snapshot's change history when the observation is contingent on a change (e.g. "after the PRESENCE-only change on 2026-08-20"). Do NOT use relative times like "24h from now".

GUIDANCE ON TYPES
- "google_ads_action": something we can execute against the Google Ads API.
- "app_code_change": code changes to the mobile/web app (React Native, Swift, Kotlin, web). Also covers Firebase/GA4 CONFIG that changes measurement behaviour even without code edits (mark_ga4_conversion_event, set_remote_config_parameter).
- "product_change": design/UX decisions requiring human judgment (paywall copy, pricing, onboarding flow structure).
- "observation": check-in tasks ("watch DebugView for 48h after change X"). If measurable, populate monitor_spec so the check is automated.
- "schedule": something to do at a future date ("re-analyse in 7 days").
- "other": anything else.

META ADS RECOMMENDATIONS — READ-ONLY (CRITICAL)

Phase 1E of the Meta integration is READ-ONLY. There is NO "meta_ads_action" type in this schema and NO Meta mutation dispatcher exists. When you recommend a Meta action:

- The step's type MUST be "observation" (or "product_change" if it's a strategic direction rather than a specific technical operation). NEVER "google_ads_action". NEVER a made-up type like "meta_ads_action".
- The action_type field MUST be null. NEVER emit action_type values like "pause_meta_ad", "set_meta_adset_budget", "boost_post", "pause_meta_campaign", "enable_meta_ad", "set_meta_bid" — none exist in this system.
- The action_params field MUST be null.
- Add a "provider": "meta_ads" hint at the top of the description so the UI can badge it. Example description opening: "[Meta Ads] Consider pausing this ad because ..."
- Frame the recommendation as observation/context. Example step title: "Consider pausing Meta ad 123 (high frequency)". The user will act on it in Meta Ads Manager manually. The apply button is deliberately absent.

If Meta ever gets a mutation dispatcher in a future phase, this instruction will be superseded. For now, treat any Meta recommendation that "looks like" it should be actionable as strictly informational.

ATTRIBUTION GUARDRAILS for plans:

Before recommending a cross-provider budget shift or claiming cross-provider outcomes:
- Check \`crossReference.metaAttribution.quality\`.
- If quality is "campaign", campaign-level cross-provider conclusions are OK for MATCHED records in \`crossReference.metaByCampaign\`.
- If quality is "partial", limit conclusions to matched records only.
- If quality is "channel" or "none", do NOT include a plan step recommending "move X% of Google budget to Meta because Meta produces cheaper customers". The data does not establish comparable customer outcomes. Instead recommend an experiment step (e.g. "Run a UTM-tagged Meta test to establish attribution") or a tracking-fix step.
- If quality is "not_requested", do not mention attribution in the plan.${META_INSTRUCTIONS}`;

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

// Extract the auto-monitor fields from an AI-emitted step, validating each
// piece. Returns nulls if anything is malformed — a bad spec means manual
// observation, not a crash. Called only for type="observation" steps.
function sanitizeMonitorFields(s) {
  const spec = safeParseMonitorSpec(s.monitor_spec);
  const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
  const check_after = isIso(s.check_after) ? new Date(s.check_after).toISOString() : null;
  const check_until = isIso(s.check_until) ? new Date(s.check_until).toISOString() : null;
  // Auto-monitor only makes sense if we have BOTH a spec and a start time.
  // If either is missing, treat the whole step as manual observation.
  if (!spec || !check_after) return { monitor_spec: null, check_after: null, check_until: null };
  return { monitor_spec: spec, check_after, check_until };
}

// Any of these strings appearing in an action_type or type field for a
// Meta-related step is a hallucination — Phase 1E is strictly read-only for
// Meta. The parser demotes such steps to type='observation' with action_type
// cleared so the UI never renders an Apply button, and the mutation
// dispatcher in routes/campaignAssistant.js can never dispatch them (its
// switch has no Meta cases).
const META_MUTATION_MARKERS = /^(meta_ads_action|meta_action|pause_meta_|resume_meta_|enable_meta_|set_meta_|update_meta_|boost_post|meta_boost_|meta_set_|meta_update_|meta_pause_|meta_resume_)/i;
const META_CONTENT_MARKERS = /\b(meta ad|meta ads|facebook ad|instagram ad|meta campaign|meta ad set|meta creative|boost post|boost this post)\b/i;

function isLikelyMetaImperative(step) {
  const at = String(step?.action_type || '').trim();
  if (at && META_MUTATION_MARKERS.test(at)) return true;
  // If action_type is one of the wired Google Ads actions but the title /
  // description talks about Meta, the model is confused — treat as Meta
  // observation, not a Google mutation.
  const combined = `${step?.title || ''}\n${step?.description || ''}`;
  if (META_CONTENT_MARKERS.test(combined) && step?.type === 'google_ads_action') return true;
  return false;
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
    .map(s => {
      // First: decide whether the step is a Meta imperative. If so, coerce
      // to a non-executable observation. This is the hard read-only guard —
      // the model is instructed not to emit these, but LLM outputs drift.
      const metaImperative = isLikelyMetaImperative(s);
      let type = knownTypes.has(s.type) ? s.type : 'other';
      let action_type = s.action_type ? String(s.action_type).slice(0, 64) : null;
      let action_params = s.action_params && typeof s.action_params === 'object' ? s.action_params : null;
      let description = String(s.description || '');
      if (metaImperative) {
        type = 'observation';
        action_type = null;
        action_params = null;
        // Prefix the description so the UI + user see clearly that this is
        // a Meta observation (no Apply button) and not a Google action.
        if (!/^\[Meta Ads\]/i.test(description)) {
          description = `[Meta Ads] ${description}`.trim();
        }
      }
      // monitor_spec/check_after/check_until only meaningful on observation steps.
      const monitor = type === 'observation' ? sanitizeMonitorFields(s) : { monitor_spec: null, check_after: null, check_until: null };
      return {
        title: String(s.title).slice(0, 500),
        description,
        type,
        action_type,
        action_params,
        priority: knownPriority.has(s.priority) ? s.priority : 'medium',
        effort: s.effort ? String(s.effort).slice(0, 32) : null,
        monitor_spec: monitor.monitor_spec,
        check_after: monitor.check_after,
        check_until: monitor.check_until,
      };
    });
  // convergence_notes is optional and only appears on consensus plans.
  if (obj.convergence_notes) obj.convergence_notes = String(obj.convergence_notes);
  return obj;
}

// ---------------------------------------------------------------------------
// Plain-prose helpers for the dialogue flow. Same providers as the plan
// synthesis calls but no JSON schema — Claude/OpenAI critique each other in
// prose during rounds 2 of the dialogue. Cheaper + faster (short outputs)
// and cache-hits the report block if included.
// ---------------------------------------------------------------------------

async function promptOpenAI({ system, user, maxTokens = 1800, temperature = 0.4 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    max_tokens: maxTokens,
  };
  const resp = await axios.post(OPENAI_URL, body, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 180_000,
  });
  const usage = resp.data?.usage || {};
  const modelUsed = resp.data?.model || OPENAI_MODEL;
  const cachedPromptTokens = usage.prompt_tokens_details?.cached_tokens || 0;
  return {
    text: resp.data?.choices?.[0]?.message?.content || '',
    model: modelUsed,
    usage: {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      cacheReadTokens: cachedPromptTokens,
      cacheWriteTokens: 0,
      costUsd: costOpenAI(modelUsed, {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        cachedPromptTokens,
      }),
    },
  };
}

async function promptClaude({ systemParts, user, maxTokens = 1800, temperature = 0.4 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: systemParts,
    messages: [{ role: 'user', content: user }],
    temperature,
  };
  const resp = await axios.post(ANTHROPIC_URL, body, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    timeout: 180_000,
  });
  const modelUsed = resp.data?.model || CLAUDE_MODEL;
  const inputTokens = resp.data?.usage?.input_tokens || 0;
  const outputTokens = resp.data?.usage?.output_tokens || 0;
  const cacheRead = resp.data?.usage?.cache_read_input_tokens || 0;
  const cacheWrite = resp.data?.usage?.cache_creation_input_tokens || 0;
  return {
    text: resp.data?.content?.[0]?.text || '',
    model: modelUsed,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: costClaude(modelUsed, {
        promptTokens: inputTokens, completionTokens: outputTokens,
        cacheRead, cacheWrite,
      }),
    },
  };
}

function sumUsage(...usages) {
  const out = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  for (const u of usages) {
    if (!u) continue;
    out.promptTokens += u.promptTokens || 0;
    out.completionTokens += u.completionTokens || 0;
    out.totalTokens += u.totalTokens || 0;
    out.cacheReadTokens += u.cacheReadTokens || 0;
    out.cacheWriteTokens += u.cacheWriteTokens || 0;
    out.costUsd += u.costUsd || 0;
  }
  out.costUsd = Number(out.costUsd.toFixed(6));
  return out;
}

// ---------------------------------------------------------------------------
// Dialogue synthesis — real back-and-forth between the two providers.
//
// Round 1: OpenAI drafts an initial plan (JSON).
// Round 2: Claude critiques the draft in prose — what to keep, change, drop,
//          add. Grounded in the transcript.
// Round 3: OpenAI reads the critique and revises the draft (JSON).
// Round 4: Claude reads the whole exchange, produces the FINAL plan JSON
//          with convergence_notes describing the dialogue.
//
// Each round genuinely sees the prior turns. If any round errors, we fall
// back to the last successful state so the user gets a plan either way.
// ---------------------------------------------------------------------------

const CRITIQUE_SYSTEM_PROMPT = `You are a senior paid-search and paid-social strategist reviewing another AI advisor's proposed action plan for a Google Ads / mobile app campaign. Be direct, specific, and grounded in the numbers.

Respond in prose (not JSON). Structure your critique as:
- WHAT I AGREE WITH: which steps are solid and why.
- WHAT I'D CHANGE: which steps are wrong, weak, or misprioritised, and specifically how you'd revise them. Cite numbers from the transcript.
- WHAT'S MISSING: important actions the plan omits.
- WHAT I'D DROP: anything speculative or not supported by the transcript.

Be concise. 400-800 words is ideal. Direct disagreement is better than hedging.`;

async function synthesizeDialoguePlan({ report, transcript }) {
  const t0 = Date.now();
  const reportStr = JSON.stringify(report);
  const reportBlock = `--- CAMPAIGN DATA ---\n${reportStr}\n--- END CAMPAIGN DATA ---`;
  const transcriptBlock = `--- DISCUSSION TRANSCRIPT ---\n${transcript}\n--- END TRANSCRIPT ---`;

  // Track state so we can fall back to the last successful plan if a later
  // round errors.
  let lastGoodPlan = null;
  let lastGoodRaw = null;
  let lastGoodModel = null;
  const usages = [];
  const dialogue = {
    openaiDraft: null,
    claudeCritique: null,
    openaiRevision: null,
  };
  const failures = [];

  // ------- Round 1: OpenAI drafts -------
  try {
    const r1 = await synthesizePlan({ provider: 'openai', report, transcript });
    dialogue.openaiDraft = r1.plan;
    lastGoodPlan = r1.plan;
    lastGoodRaw = r1.rawResponse;
    lastGoodModel = r1.model;
    usages.push(r1.usage);
  } catch (err) {
    failures.push({ round: 1, error: err.message });
  }

  // ------- Round 2: Claude critiques -------
  if (dialogue.openaiDraft) {
    try {
      const r2 = await promptClaude({
        systemParts: [
          { type: 'text', text: CRITIQUE_SYSTEM_PROMPT },
          { type: 'text', text: reportBlock, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: transcriptBlock },
        ],
        user: `OpenAI proposed the following action plan after the campaign discussion:

${JSON.stringify(dialogue.openaiDraft, null, 2)}

Give your critique.`,
        maxTokens: 2000,
      });
      dialogue.claudeCritique = r2.text;
      usages.push(r2.usage);
    } catch (err) {
      failures.push({ round: 2, error: err.message });
    }
  }

  // ------- Round 3: OpenAI revises -------
  if (dialogue.openaiDraft && dialogue.claudeCritique) {
    try {
      const r3 = await synthesizePlanOpenAI({
        report,
        systemPrompt: PLAN_SYSTEM_PROMPT + `

You will receive:
- Your own initial draft plan
- Claude's critique of that draft

Revise your plan in response to the critique. You may accept, partially accept, or reject each point of critique — use your judgment. Output the revised JSON plan in the SAME schema as before (no critique text, just the plan).`,
        userPrompt: `=== YOUR INITIAL DRAFT ===
${JSON.stringify(dialogue.openaiDraft, null, 2)}

=== CLAUDE'S CRITIQUE ===
${dialogue.claudeCritique}

=== YOUR REVISED PLAN (output JSON only) ===`,
        t0: Date.now(),
      });
      dialogue.openaiRevision = r3.plan;
      lastGoodPlan = r3.plan;
      lastGoodRaw = r3.rawResponse;
      lastGoodModel = r3.model;
      usages.push(r3.usage);
    } catch (err) {
      failures.push({ round: 3, error: err.message });
    }
  }

  // ------- Round 4: Claude finalizes with convergence_notes -------
  if (dialogue.openaiDraft && dialogue.claudeCritique && dialogue.openaiRevision) {
    try {
      const r4 = await synthesizePlanClaude({
        report,
        systemPrompt: PLAN_SYSTEM_PROMPT + `

CONSENSUS-FINALIZATION MODE

You are producing the FINAL action plan after a 4-round dialogue with OpenAI. You will see:
- OpenAI's initial draft
- Your prior critique of that draft
- OpenAI's revised draft (which responded to your critique)

Your task: output the final plan JSON. Rules:
- If OpenAI's revision addressed your critique well, adopt it largely as-is.
- If OpenAI dismissed valid critique points, adjust the plan yourself to reflect your position — you have the last word.
- Add or reorder steps as needed based on the exchange.
- MUST include a top-level "convergence_notes" field (3-6 sentences): what both models agreed on from the start, what you critiqued, how OpenAI responded, and what your final position is on any remaining disagreements.

Output JSON only.`,
        userPrompt: `=== ROUND 1 — OpenAI's initial draft ===
${JSON.stringify(dialogue.openaiDraft, null, 2)}

=== ROUND 2 — Your critique ===
${dialogue.claudeCritique}

=== ROUND 3 — OpenAI's revised draft (responding to your critique) ===
${JSON.stringify(dialogue.openaiRevision, null, 2)}

=== ROUND 4 — Your final plan (output JSON only, must include "convergence_notes") ===`,
        t0: Date.now(),
      });
      lastGoodPlan = r4.plan;
      lastGoodRaw = r4.rawResponse;
      lastGoodModel = r4.model;
      usages.push(r4.usage);
    } catch (err) {
      failures.push({ round: 4, error: err.message });
    }
  }

  // If ALL rounds failed, error out.
  if (!lastGoodPlan) {
    const msg = failures.length
      ? `All dialogue rounds failed: ${failures.map(f => `R${f.round}=${f.error}`).join('; ')}`
      : 'Dialogue produced no plan';
    throw new Error(msg);
  }

  const degraded = failures.length > 0;
  const modelDesc = degraded
    ? `${lastGoodModel} (dialogue partial: rounds ${[1, 2, 3, 4].filter(r => !failures.find(f => f.round === r)).join(',')} completed)`
    : `openai→claude→openai→claude dialogue (final: ${lastGoodModel})`;

  return {
    plan: lastGoodPlan,
    rawResponse: lastGoodRaw,
    model: modelDesc,
    provider: 'dialogue',
    usage: sumUsage(...usages),
    dialogue,
    failures,
    degraded,
    durationMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Consensus synthesis — both models propose in parallel, then one reconciles.
//
// Phase 1: Both models independently draft a plan from the transcript.
// Phase 2: Claude receives both drafts + transcript, merges into ONE
//          authoritative plan and emits a "convergence_notes" field
//          summarising agreements + resolved disagreements.
//
// This gives the user a genuinely joint recommendation instead of forcing
// them to pick a model. Cost is roughly 2.5x a single-provider synthesis
// (parallel drafts + one merge call), latency ~60-120s total.
// ---------------------------------------------------------------------------

const RECONCILE_SYSTEM_ADDENDUM = `
YOU ARE IN CONSENSUS MODE.

You will be given TWO independently-drafted action plans (one from OpenAI, one from Claude) plus the original discussion transcript. Your job is to merge them into ONE authoritative plan the team will act on.

Rules for the merge:
- If both drafts contain the same recommendation (even worded differently), keep ONE entry and use the clearer wording.
- If only one draft proposed a step, keep it IF it's clearly grounded in the transcript. Drop it if it looks speculative.
- If the two drafts contradict each other on a specific point (e.g. one says "raise budget", the other says "hold budget"), pick the side better supported by numbers in the transcript, and note the disagreement in convergence_notes.
- Order by dependency. Broken-tracking issues first.
- 5-15 steps ideal.

Output the SAME JSON schema as before, PLUS a top-level field:

"convergence_notes": string (2-5 sentences: where the two drafts agreed, where they disagreed, and how you resolved the disagreements)

Output JSON only.`;

async function synthesizeConsensusPlan({ report, transcript }) {
  const t0 = Date.now();

  // Phase 1: parallel drafts from both providers.
  const [openaiRes, claudeRes] = await Promise.all([
    synthesizePlan({ provider: 'openai', report, transcript }).catch(err => ({ error: err })),
    synthesizePlan({ provider: 'claude', report, transcript }).catch(err => ({ error: err })),
  ]);

  const openaiDraft = openaiRes.error ? null : openaiRes;
  const claudeDraft = claudeRes.error ? null : claudeRes;

  // If both failed, bubble up.
  if (!openaiDraft && !claudeDraft) {
    const err = openaiRes.error || claudeRes.error || new Error('Both draft syntheses failed');
    throw err;
  }

  // If one failed, fall back to the other draft — no reconciliation needed.
  if (!openaiDraft || !claudeDraft) {
    const only = openaiDraft || claudeDraft;
    return {
      plan: only.plan,
      rawResponse: only.rawResponse,
      model: only.model,
      provider: only.provider,
      usage: only.usage,
      drafts: {
        openai: openaiDraft?.plan || null,
        claude: claudeDraft?.plan || null,
        openaiError: openaiRes.error?.message || null,
        claudeError: claudeRes.error?.message || null,
      },
      degraded: true,   // signals to the caller only one draft succeeded
      durationMs: Date.now() - t0,
    };
  }

  // Phase 2: reconciliation call to Claude (chosen for stronger structured
  // synthesis behaviour on this class of task).
  const reconcilePrompt = `Two independent action plans were drafted for the same campaign discussion. Merge them into ONE authoritative plan.

=== DRAFT A (from OpenAI) ===
${JSON.stringify(openaiDraft.plan, null, 2)}
=== END DRAFT A ===

=== DRAFT B (from Claude) ===
${JSON.stringify(claudeDraft.plan, null, 2)}
=== END DRAFT B ===

=== ORIGINAL DISCUSSION TRANSCRIPT ===
${transcript}
=== END TRANSCRIPT ===

Produce the merged JSON plan now, including "convergence_notes".`;

  const reconciled = await synthesizePlanClaude({
    report,
    systemPrompt: PLAN_SYSTEM_PROMPT + '\n\n' + RECONCILE_SYSTEM_ADDENDUM,
    userPrompt: reconcilePrompt,
    t0,
  });

  const combinedUsage = {
    promptTokens: (openaiDraft.usage.promptTokens || 0) + (claudeDraft.usage.promptTokens || 0) + (reconciled.usage.promptTokens || 0),
    completionTokens: (openaiDraft.usage.completionTokens || 0) + (claudeDraft.usage.completionTokens || 0) + (reconciled.usage.completionTokens || 0),
    totalTokens: 0,
    cacheReadTokens: (openaiDraft.usage.cacheReadTokens || 0) + (claudeDraft.usage.cacheReadTokens || 0) + (reconciled.usage.cacheReadTokens || 0),
    cacheWriteTokens: (openaiDraft.usage.cacheWriteTokens || 0) + (claudeDraft.usage.cacheWriteTokens || 0) + (reconciled.usage.cacheWriteTokens || 0),
    costUsd: Number(((openaiDraft.usage.costUsd || 0) + (claudeDraft.usage.costUsd || 0) + (reconciled.usage.costUsd || 0)).toFixed(6)),
  };
  combinedUsage.totalTokens = combinedUsage.promptTokens + combinedUsage.completionTokens;

  return {
    plan: reconciled.plan,
    rawResponse: reconciled.rawResponse,
    model: `openai:${openaiDraft.model} + claude:${claudeDraft.model} → claude:${reconciled.model}`,
    provider: 'consensus',
    usage: combinedUsage,
    drafts: {
      openai: openaiDraft.plan,
      claude: claudeDraft.plan,
    },
    degraded: false,
    durationMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Edit-ops synthesis — for regenerating a LIVING plan in place.
//
// Old flow: regenerate produced a fresh plan JSON. Continuity was
// reconstructed after the fact via fuzzy title matching. Broke every time
// the AI paraphrased a step.
//
// New flow: regenerate produces EDIT OPERATIONS against the existing plan.
// Each op references a step_id (UUID) so identity is stable. AI outputs
// only what changed — no ops means "the plan is fine as-is". Kills the
// entire "my done tasks come back as pending" class of bug.
//
// Single-shot (not 4-round dialogue) — editing is a review pass, not a
// creative synthesis. If quality regresses we can add a second-pass
// review from the other provider.
// ---------------------------------------------------------------------------

const EDIT_OPS_SYSTEM_PROMPT = `You are updating a LIVING plan for a Google Ads campaign — not generating a new one from scratch.

The user has been working through this plan across multiple sessions. Every existing step has a stable ID and a current status (pending / done / applied / skipped / failed). Your job: review the current plan + the campaign snapshot + the discussion transcript, and output a MINIMAL set of edit operations. Do NOT re-emit steps that don't need changing.

OUTPUT SCHEMA — valid JSON only, no prose, no code fences:

{
  "summary": string (1-2 sentences describing what changed and why — shown to the user post-regen),
  "operations": [
    // Add a NEW step that doesn't exist in the current plan. For type="observation" that maps to a wired monitor source, populate monitor_spec + check_after + check_until (see the AUTO-MONITOR CATALOG that was in the initial-plan prompt: sources = ga4_event_rate | ga4_event_count | google_ads_geo_share, threshold = {op, value}, dates as ISO 8601).
    {"op":"add","position":<0-based insertion index in the current step list>,"step":{"title","description","type","action_type"|null,"action_params"|null,"priority","effort","monitor_spec"|null,"check_after"|null,"check_until"|null},"reason":"why this is new work"},

    // Refactor an existing step's title/description, OR retrofit auto-monitor fields onto an existing observation step that lacks them. Any of newTitle/newDescription/monitor_spec may be omitted; at least one must be present.
    {"op":"refactor","step_id":"<uuid>","newTitle":"...","newDescription":"...","monitor_spec":{...} | null,"check_after":"<ISO 8601>" | null,"check_until":"<ISO 8601>" | null,"reason":"why the reshape"},

    // Mark a step's status transition (PROGRESSION-ONLY — no 'pending' allowed here)
    {"op":"mark","step_id":"<uuid>","status":"done"|"applied"|"skipped"|"failed","reason":"why the transition"},

    // Drop a step that's obsolete (based on a since-disproven assumption or superseded by other work)
    {"op":"drop","step_id":"<uuid>","reason":"why to drop"}
  ]
}

HARD RULES:
- NEVER add a new step that substantively duplicates any existing step (even if paraphrased). If you catch yourself doing this, use "refactor" on the existing step instead.
- NEVER drop a step that is already "done" or "applied" — that's the user's completed work; it stays as historical record. Only drop "pending" steps that have become obsolete.
- NEVER "mark" a step back to "pending". Status transitions are PROGRESSION-ONLY (pending → done/applied/skipped/failed). If a done step needs more work, "refactor" it (title/description stays, status stays done, discussion continues). If it needs to be re-opened, that's a user action — not yours.
- If a step is "pending" and the campaign snapshot / transcript shows the underlying work has been completed (e.g. user reported it, the metric moved, the change history confirms it), use "mark" with status="done".
- If a step is "failed" and the discussion suggests a different approach might work, use "refactor" — don't add a new step for the retry.
- For "refactor" and "mark" and "drop": step_id MUST match an existing step's UUID from the CURRENT PLAN block. If uncertain, prefer no-op over guessing.
- Empty operations array is a valid, correct output — it means the plan is fine as-is and nothing new needs to happen.

AIM FOR MINIMAL EDITS. If the discussion contains one new piece of info, expect 1-2 ops. Only when the whole strategy has shifted should you have >5 ops.

AUTO-MONITOR CATALOG (for populating monitor_spec on observation steps — via "add" for new observations, via "refactor" to retrofit existing observation steps marked [monitor: NO]):

- source: "ga4_event_rate" — ratio of two GA4 event counts over N days
    params: { numerator_event, denominator_event, days:1..90 }
    threshold: { op: "<"|"<="|">"|">="|"==", value:<0..1 rate> }
    Example: cancellation rate below 30% → source=ga4_event_rate, params={numerator_event:"purchase_cancelled", denominator_event:"purchase_started", days:14}, threshold={op:"<", value:0.30}

- source: "ga4_event_count" — raw event count over N days
    params: { event_name, days:1..90 }
    threshold: { op:">="|">"|"<="|"<"|"==", value:<integer> }
    Example: trial_started climbing → source=ga4_event_count, params={event_name:"trial_started", days:2}, threshold={op:">=", value:5}

- source: "google_ads_geo_share" — % of impressions from a country criterion
    params: { country_criterion_id, days:1..90 }
    threshold: { op:"<"|"<=", value:<0..1 fraction> }
    Example: South Korea drops below 5% → source=google_ads_geo_share, params={country_criterion_id:"2410", days:7}, threshold={op:"<", value:0.05}

check_after = earliest ISO timestamp checking makes sense (change_date + data_lag, typically +24-48h).
check_until = deadline ISO timestamp (change_date + observation window, e.g. +14d).
target_description = human-readable one-liner matching the threshold intent.

Retrofit is HIGH-VALUE: any observation step marked [monitor: NO — eligible for retrofit] that measures a wired source should get monitor_spec added via refactor so it stops requiring manual re-check.

CURRENT PLAN STATE will be given in the user message. Use the step_id values shown there.`;

async function synthesizeEditOps({ report, transcript, currentPlan, currentSteps }) {
  const t0 = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  // Format the current plan state for the AI to reference. Exposing `type` and
  // whether monitor_spec is set lets the AI spot observation steps that are
  // eligible for auto-monitor retrofit via refactor.
  const stepLines = (currentSteps || []).map((s, i) => {
    const monitorFlag = s.type === 'observation'
      ? (s.monitor_spec ? ' [monitor: yes]' : ' [monitor: NO — eligible for retrofit]')
      : '';
    return `  [step_id: ${s.id}] [position: ${i}] [status: ${s.status || 'pending'}] [type: ${s.type || 'other'}]${monitorFlag} ${s.title}` +
      (s.description ? `\n     desc: ${s.description.replace(/\s+/g, ' ').slice(0, 400)}` : '') +
      (s.notes ? `\n     notes: ${s.notes.replace(/\s+/g, ' ').slice(0, 400)}` : '');
  }).join('\n');
  const planStateBlock = `=== CURRENT PLAN ===
Title: ${currentPlan.title || '(untitled)'}
Summary: ${currentPlan.summary || '(none)'}

Steps (${(currentSteps || []).length} total):
${stepLines || '  (no steps yet)'}
=== END CURRENT PLAN ===`;

  const userPrompt = `${planStateBlock}

=== DISCUSSION TRANSCRIPT (may begin with PRIOR PLAN OUTCOMES) ===
${transcript}
=== END TRANSCRIPT ===

Output the edit operations JSON now. Empty operations is fine.`;

  // Two-part system so the (big) report gets its own cache breakpoint.
  const system = [
    { type: 'text', text: EDIT_OPS_SYSTEM_PROMPT },
    {
      type: 'text',
      text: `--- CAMPAIGN DATA (for numeric citations) ---\n${JSON.stringify(report)}\n--- END CAMPAIGN DATA ---`,
      cache_control: { type: 'ephemeral' },
    },
  ];

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 3000,
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

  const parsed = safeParseEditOps(raw);

  return {
    summary: parsed.summary || '',
    operations: parsed.operations || [],
    rawResponse: raw,
    model: modelUsed,
    provider: 'claude',
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: costClaude(modelUsed, {
        promptTokens: inputTokens, completionTokens: outputTokens,
        cacheRead, cacheWrite,
      }),
    },
    durationMs: Date.now() - t0,
  };
}

const VALID_EDIT_OP_TYPES = new Set(['add', 'refactor', 'mark', 'drop']);
// AI can only PROGRESS a step (pending → done/applied/skipped/failed).
// Demotion back to 'pending' is a user-only action. Accepting AI-emitted
// 'pending' caused done items to silently regress on regen.
const VALID_EDIT_STATUS = new Set(['done', 'applied', 'skipped', 'failed']);

function safeParseEditOps(text) {
  if (!text) throw new Error('Empty edit-ops response');
  let trimmed = String(text).trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) trimmed = fence[1].trim();
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch (_) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Edit-ops response was not valid JSON');
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Edit-ops JSON is not an object');
  const summary = String(parsed.summary || '');
  const rawOps = Array.isArray(parsed.operations) ? parsed.operations : [];
  const operations = [];
  for (const op of rawOps) {
    if (!op || typeof op !== 'object' || !VALID_EDIT_OP_TYPES.has(op.op)) continue;
    const clean = { op: op.op, reason: op.reason ? String(op.reason).slice(0, 2000) : null };
    if (op.op === 'add') {
      if (!op.step || typeof op.step !== 'object' || !op.step.title) continue;
      clean.position = Number.isInteger(op.position) ? op.position : null;
      const knownTypes = new Set(['google_ads_action', 'app_code_change', 'product_change', 'observation', 'schedule', 'other']);
      const knownPriority = new Set(['high', 'medium', 'low']);
      const type = knownTypes.has(op.step.type) ? op.step.type : 'other';
      const monitor = type === 'observation' ? sanitizeMonitorFields(op.step) : { monitor_spec: null, check_after: null, check_until: null };
      clean.step = {
        title: String(op.step.title).slice(0, 500),
        description: String(op.step.description || ''),
        type,
        action_type: op.step.action_type ? String(op.step.action_type).slice(0, 64) : null,
        action_params: op.step.action_params && typeof op.step.action_params === 'object' ? op.step.action_params : null,
        priority: knownPriority.has(op.step.priority) ? op.step.priority : 'medium',
        effort: op.step.effort ? String(op.step.effort).slice(0, 32) : null,
        monitor_spec: monitor.monitor_spec,
        check_after: monitor.check_after,
        check_until: monitor.check_until,
      };
    } else if (op.op === 'refactor') {
      if (!op.step_id) continue;
      clean.step_id = String(op.step_id);
      if (op.newTitle) clean.newTitle = String(op.newTitle).slice(0, 500);
      if (op.newDescription) clean.newDescription = String(op.newDescription);
      // Allow refactor to also SET or REPLACE monitor fields on an existing
      // step. This is how the AI retrofits auto-monitoring onto observation
      // steps that were created before the monitor feature existed.
      const monitor = sanitizeMonitorFields(op);
      if (monitor.monitor_spec) {
        clean.newMonitorSpec = monitor.monitor_spec;
        clean.newCheckAfter = monitor.check_after;
        clean.newCheckUntil = monitor.check_until;
      }
      if (!clean.newTitle && !clean.newDescription && !clean.newMonitorSpec) continue;
    } else if (op.op === 'mark') {
      if (!op.step_id || !VALID_EDIT_STATUS.has(op.status)) continue;
      clean.step_id = String(op.step_id);
      clean.status = op.status;
    } else if (op.op === 'drop') {
      if (!op.step_id) continue;
      clean.step_id = String(op.step_id);
    }
    operations.push(clean);
  }
  return { summary, operations };
}

module.exports = {
  streamOpenAI,
  streamClaude,
  messagesForProvider,
  synthesizePlan,
  synthesizeConsensusPlan,
  synthesizeDialoguePlan,
  synthesizeEditOps,
  buildPlanProgressBlock,
  OPENAI_MODEL,
  CLAUDE_MODEL,
  INITIAL_ANALYSIS_PROMPT,
  _internal: { costOpenAI, costClaude, buildOpenAiSystemContent, buildClaudeSystemArray, safeParsePlan, safeParseEditOps, isLikelyMetaImperative, META_MUTATION_MARKERS, META_CONTENT_MARKERS, validatePlanShape, META_INSTRUCTIONS },
};
