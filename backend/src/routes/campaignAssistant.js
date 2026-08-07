// Campaign Assistant — chat over a Google Ads + GA4 + Firebase-events +
// OpenAI-Ads report snapshot with side-by-side OpenAI + Claude replies.
//
// Endpoints (all authed; conversation-creation requires business auth):
//   GET    /api/campaign-assistant/conversations                 → list mine
//   POST   /api/campaign-assistant/conversations                 → create + snapshot report
//   GET    /api/campaign-assistant/conversations/:id             → conversation + messages
//   DELETE /api/campaign-assistant/conversations/:id             → delete
//   POST   /api/campaign-assistant/conversations/:id/chat        → SSE stream (both providers)
//   POST   /api/campaign-assistant/messages/:id/rate             → +1 / -1 / null
//
// SSE frame format:
//   data: {"type":"delta","provider":"openai","text":"..."}\n\n
//   data: {"type":"complete","provider":"openai","messageId":"...","costUsd":..,"promptTokens":..,"completionTokens":..,"cacheReadTokens":..,"cacheWriteTokens":..}\n\n
//   data: {"type":"error","provider":"claude","error":"..."}\n\n
//   data: {"type":"done"}\n\n     ← both providers finished (success or error)

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const optimizationReport = require('../services/optimizationReportService');
const campaignAssistant = require('../services/campaignAssistantService');
const openAiAds = require('../services/openAiAdsService');
const connectionsService = require('../services/connectionsService');
const { getAllBusinessTokens } = require('../utils/businessTokens');
const logger = require('../utils/logger');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);

const ALLOWED_DAYS = [7, 14, 30, 60, 90, 180, 365];
const MAX_USER_MESSAGE_CHARS = 4000;
const MAX_CONVERSATIONS_PER_LIST = 100;

function parseDays(input, fallback = 30) {
  const n = parseInt(input, 10);
  return ALLOWED_DAYS.includes(n) ? n : fallback;
}

function digitsOnly(s) {
  return String(s || '').replace(/[^0-9]/g, '');
}

// -- Google account resolution (reused from optimizationReport route pattern) --

async function resolveAdsCustomer(userId, customerIdRaw) {
  const cid = digitsOnly(customerIdRaw);
  if (!cid) {
    const { data } = await supabase
      .from('connected_accounts')
      .select('display_name, metadata, created_at')
      .eq('user_id', userId)
      .eq('provider', 'google_ads')
      .order('created_at', { ascending: false })
      .limit(1);
    if (!data || !data[0]) return { customerId: null };
    return {
      customerId: data[0].metadata?.customer_id || null,
      loginCustomerId: data[0].metadata?.manager_customer_id || null,
      ownerGoogleId: data[0].metadata?.owner_google_id || null,
      descriptiveName: data[0].display_name || null,
    };
  }
  const { data } = await supabase
    .from('connected_accounts')
    .select('display_name, metadata')
    .eq('user_id', userId)
    .eq('provider', 'google_ads')
    .eq('external_id', `ads:${cid}`)
    .limit(1);
  const meta = data && data[0]?.metadata;
  return {
    customerId: cid,
    loginCustomerId: meta?.manager_customer_id || null,
    ownerGoogleId: meta?.owner_google_id || null,
    descriptiveName: data && data[0]?.display_name || null,
  };
}

async function resolveGa4Property(userId, propertyIdRaw) {
  const pid = String(propertyIdRaw || '').trim();
  if (!pid) return { propertyId: null };
  const { data } = await supabase
    .from('connected_accounts')
    .select('display_name, metadata')
    .eq('user_id', userId)
    .eq('provider', 'google_analytics')
    .eq('external_id', `ga4:${pid}`)
    .limit(1);
  return {
    propertyId: pid,
    ownerGoogleId: data && data[0]?.metadata?.owner_google_id || null,
    displayName: data && data[0]?.display_name || null,
  };
}

async function tokenForOwner(req, ownerGoogleId) {
  if (!ownerGoogleId) return req.businessToken;
  const tokens = await getAllBusinessTokens(req.user.userId);
  const match = tokens.find(t => t.google_id === ownerGoogleId);
  return match?.access_token || req.businessToken;
}

// Pull a compact OpenAI Ads snapshot for the report. Kept small on purpose —
// this ends up in the model's system prompt on every turn.
async function fetchOpenAiAdsHistory({ userId, connectionId, days }) {
  if (!connectionId) return null;
  try {
    const [campaigns, adGroups, ads, insights] = await Promise.all([
      openAiAds.getCampaigns({ userId, connectionId }).catch(() => null),
      openAiAds.getAdGroups({ userId, connectionId }).catch(() => null),
      openAiAds.getAds({ userId, connectionId }).catch(() => null),
      openAiAds.getInsights({
        userId, connectionId,
        scope: 'account',
        aggregationLevel: 'campaign',
        days,
        granularity: 'none',
      }).catch(() => null),
    ]);
    return { campaigns, adGroups, ads, insights };
  } catch (err) {
    logger.warn('campaignAssistant.openai_ads_history_failed', {
      userId, connectionId, error: err.message,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /conversations — list
// ---------------------------------------------------------------------------
router.get('/conversations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaign_assistant_conversations')
      .select('id, title, google_ads_customer_id, campaign_id, campaign_name, ga4_property_id, ga4_app_property_id, days, created_at, updated_at')
      .eq('user_id', req.user.userId)
      .order('updated_at', { ascending: false })
      .limit(MAX_CONVERSATIONS_PER_LIST);
    if (error) throw error;
    res.json({ conversations: data || [] });
  } catch (err) {
    logger.error('campaignAssistant.list_failed', { userId: req.user.userId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /conversations/:id — one with messages
// ---------------------------------------------------------------------------
router.get('/conversations/:id', async (req, res) => {
  try {
    const { data: conv, error: convErr } = await supabase
      .from('campaign_assistant_conversations')
      .select('*')
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id)
      .single();
    if (convErr || !conv) return res.status(404).json({ error: 'Not found' });

    const { data: messages, error: msgErr } = await supabase
      .from('campaign_assistant_messages')
      .select('id, turn_index, role, provider, model, content, status, error, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, cost_usd, rating, created_at')
      .eq('conversation_id', conv.id)
      .order('turn_index', { ascending: true })
      .order('created_at', { ascending: true });
    if (msgErr) throw msgErr;

    // Do NOT ship the full report_snapshot in the GET response — it's large
    // and only the server needs it for follow-up chat turns. Ship a slim
    // subset the UI actually renders.
    const { report_snapshot, ...rest } = conv;
    const snapshotMeta = report_snapshot ? {
      summary: report_snapshot.summary || null,
      alerts: report_snapshot.alerts || null,
      account: report_snapshot.account || null,
      hasFirebase: !!report_snapshot.firebase,
      hasOpenAiAds: !!report_snapshot.openAiAds,
      errors: report_snapshot.errors || null,
    } : null;

    res.json({ conversation: rest, snapshotMeta, messages: messages || [] });
  } catch (err) {
    logger.error('campaignAssistant.get_failed', {
      userId: req.user.userId, id: req.params.id, error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /conversations/:id
// ---------------------------------------------------------------------------
router.delete('/conversations/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('campaign_assistant_conversations')
      .delete()
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    logger.error('campaignAssistant.delete_failed', {
      userId: req.user.userId, id: req.params.id, error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /conversations — create + capture report snapshot
// ---------------------------------------------------------------------------
router.post('/conversations', requireBusinessAuth, async (req, res) => {
  const userId = req.user.userId;
  const t0 = Date.now();
  try {
    const {
      customerId, campaignId, campaignName,
      propertyId, firebasePropertyId, openAiAdsConnectionId,
      title,
    } = req.body || {};
    const days = parseDays(req.body?.days, 30);
    const campaignIdClean = digitsOnly(campaignId);

    const [adsCustomer, ga4Prop, ga4AppProp] = await Promise.all([
      resolveAdsCustomer(userId, customerId),
      resolveGa4Property(userId, propertyId),
      resolveGa4Property(userId, firebasePropertyId),
    ]);
    if (!adsCustomer.customerId) {
      return res.status(400).json({ error: 'Google Ads customer required or not connected' });
    }
    if (!campaignIdClean) {
      return res.status(400).json({ error: 'campaignId required' });
    }

    const [adsToken, ga4Token, ga4AppToken] = await Promise.all([
      tokenForOwner(req, adsCustomer.ownerGoogleId),
      ga4Prop.propertyId ? tokenForOwner(req, ga4Prop.ownerGoogleId) : Promise.resolve(null),
      ga4AppProp.propertyId ? tokenForOwner(req, ga4AppProp.ownerGoogleId) : Promise.resolve(null),
    ]);

    // OpenAI Ads history is optional context. Failure to fetch is not fatal.
    const openAiAdsHistory = await fetchOpenAiAdsHistory({
      userId,
      connectionId: openAiAdsConnectionId || null,
      days,
    });

    const report = await optimizationReport.generateReport({
      adsAccessToken: adsToken,
      customerId: adsCustomer.customerId,
      loginCustomerId: adsCustomer.loginCustomerId,
      campaignId: campaignIdClean,
      ga4AccessToken: ga4Token,
      propertyId: ga4Prop.propertyId,
      firebaseAccessToken: ga4AppToken,
      firebasePropertyId: ga4AppProp.propertyId,
      openAiAdsHistory,
      days,
      userId,
    });

    report.account = {
      customerId: adsCustomer.customerId,
      descriptiveName: campaignName || adsCustomer.descriptiveName || null,
      loginCustomerId: adsCustomer.loginCustomerId,
      ga4PropertyId: ga4Prop.propertyId,
      ga4PropertyName: ga4Prop.displayName,
      firebasePropertyId: ga4AppProp.propertyId,
      firebasePropertyName: ga4AppProp.displayName,
    };

    const now = new Date().toISOString();
    const { data: conv, error: convErr } = await supabase
      .from('campaign_assistant_conversations')
      .insert({
        user_id: userId,
        title: (title || campaignName || `Campaign ${campaignIdClean}`).slice(0, 255),
        google_ads_customer_id: adsCustomer.customerId,
        google_ads_login_customer_id: adsCustomer.loginCustomerId,
        campaign_id: campaignIdClean,
        campaign_name: campaignName || null,
        ga4_property_id: ga4Prop.propertyId,
        ga4_app_property_id: ga4AppProp.propertyId,
        openai_ads_connection_id: openAiAdsConnectionId || null,
        days,
        report_snapshot: report,
        report_generated_at: now,
      })
      .select()
      .single();
    if (convErr) throw new Error(`Failed to persist conversation: ${convErr.message}`);

    logger.info('campaignAssistant.conversation_created', {
      userId,
      conversationId: conv.id,
      customerId: adsCustomer.customerId,
      campaignId: campaignIdClean,
      days,
      hasFirebase: !!ga4AppProp.propertyId,
      hasOpenAiAds: !!openAiAdsHistory,
      snapshotErrors: (report.errors || []).length,
      duration_ms: Date.now() - t0,
    });

    res.json({
      conversation: {
        id: conv.id,
        title: conv.title,
        campaign_id: conv.campaign_id,
        campaign_name: conv.campaign_name,
        google_ads_customer_id: conv.google_ads_customer_id,
        ga4_property_id: conv.ga4_property_id,
        ga4_app_property_id: conv.ga4_app_property_id,
        days: conv.days,
        created_at: conv.created_at,
      },
      snapshotMeta: {
        summary: report.summary,
        alerts: report.alerts,
        account: report.account,
        hasFirebase: !!report.firebase,
        hasOpenAiAds: !!report.openAiAds,
        errors: report.errors || null,
      },
      initialAnalysisPrompt: campaignAssistant.INITIAL_ANALYSIS_PROMPT,
    });
  } catch (err) {
    logger.error('campaignAssistant.create_failed', {
      userId, error: err.message, duration_ms: Date.now() - t0,
    });
    res.status(err.status || 500).json({ error: err.message || 'Failed to create conversation' });
  }
});

// ---------------------------------------------------------------------------
// POST /conversations/:id/chat — SSE, both providers in parallel
// ---------------------------------------------------------------------------
router.post('/conversations/:id/chat', async (req, res) => {
  const userId = req.user.userId;
  const conversationId = req.params.id;
  const message = String(req.body?.message || '').trim().slice(0, MAX_USER_MESSAGE_CHARS);
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (!message && attachments.length === 0) {
    return res.status(400).json({ error: 'message or attachment required' });
  }

  // Load conversation (must belong to user) and its full report snapshot.
  const { data: conv, error: convErr } = await supabase
    .from('campaign_assistant_conversations')
    .select('id, report_snapshot, title')
    .eq('user_id', userId)
    .eq('id', conversationId)
    .single();
  if (convErr || !conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  if (!conv.report_snapshot) {
    return res.status(400).json({ error: 'Conversation is missing a report snapshot' });
  }

  // Load prior messages to build per-provider chat history.
  const { data: priorMessages, error: histErr } = await supabase
    .from('campaign_assistant_messages')
    .select('id, turn_index, role, provider, content, status')
    .eq('conversation_id', conversationId)
    .order('turn_index', { ascending: true })
    .order('created_at', { ascending: true });
  if (histErr) {
    return res.status(500).json({ error: histErr.message });
  }

  // Compute next turn_index (user turns and their two assistant replies share
  // the same turn_index, so the UI can pair them).
  const maxTurn = (priorMessages || []).reduce((m, x) => Math.max(m, x.turn_index ?? -1), -1);
  const nextTurn = maxTurn + 1;

  // Persist the user message first so the DB is source of truth even if
  // the connection dies before either provider finishes.
  const { data: userRow, error: userInsertErr } = await supabase
    .from('campaign_assistant_messages')
    .insert({
      conversation_id: conversationId,
      turn_index: nextTurn,
      role: 'user',
      content: message,
      status: 'complete',
    })
    .select()
    .single();
  if (userInsertErr) {
    return res.status(500).json({ error: userInsertErr.message });
  }

  // Auto-title conversation from the first user message if not yet titled.
  if (nextTurn === 0) {
    const derivedTitle = (conv.title && conv.title.length > 0) ? conv.title : message.slice(0, 80);
    await supabase
      .from('campaign_assistant_conversations')
      .update({ title: derivedTitle })
      .eq('id', conversationId);
  } else {
    // Just bump updated_at so the sidebar list re-sorts.
    await supabase
      .from('campaign_assistant_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);
  }

  // Insert placeholder assistant rows in 'streaming' status so the UI can
  // link streamed deltas to their eventual DB row via messageId. We PATCH
  // these rows on completion.
  const now = new Date().toISOString();
  const { data: placeholders, error: phErr } = await supabase
    .from('campaign_assistant_messages')
    .insert([
      {
        conversation_id: conversationId, turn_index: nextTurn,
        role: 'assistant', provider: 'openai', content: '', status: 'streaming', created_at: now,
      },
      {
        conversation_id: conversationId, turn_index: nextTurn,
        role: 'assistant', provider: 'claude', content: '', status: 'streaming',
        // +1ms so the (turn_index, created_at) sort is stable.
        created_at: new Date(Date.now() + 1).toISOString(),
      },
    ])
    .select();
  if (phErr) {
    return res.status(500).json({ error: phErr.message });
  }
  const openaiRow = placeholders.find(r => r.provider === 'openai');
  const claudeRow = placeholders.find(r => r.provider === 'claude');

  // Build message history per provider. Then append the just-inserted user message.
  const openaiMessages = [
    ...campaignAssistant.messagesForProvider(priorMessages || [], 'openai'),
    { role: 'user', content: message },
  ];
  const claudeMessages = [
    ...campaignAssistant.messagesForProvider(priorMessages || [], 'claude'),
    { role: 'user', content: message },
  ];

  // Open SSE.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = obj => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) { /* client gone */ }
  };
  write({ type: 'start', turnIndex: nextTurn, userMessageId: userRow.id, openaiMessageId: openaiRow.id, claudeMessageId: claudeRow.id });

  // Heartbeat every 25s so proxies don't close idle connection.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
  }, 25_000);

  let done = 0;
  const finish = () => {
    done += 1;
    if (done >= 2) {
      clearInterval(heartbeat);
      write({ type: 'done' });
      res.end();
    }
  };

  const persistCompletion = async (row, result) => {
    await supabase
      .from('campaign_assistant_messages')
      .update({
        content: result.content || '',
        status: 'complete',
        model: result.model,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        total_tokens: result.totalTokens,
        cache_read_tokens: result.cacheReadTokens,
        cache_write_tokens: result.cacheWriteTokens,
        cost_usd: result.costUsd,
      })
      .eq('id', row.id);
  };

  const persistFailure = async (row, err) => {
    await supabase
      .from('campaign_assistant_messages')
      .update({
        status: 'failed',
        error: String(err?.message || 'unknown error').slice(0, 4000),
      })
      .eq('id', row.id);
  };

  // Kick off both providers concurrently.
  campaignAssistant.streamOpenAI({
    report: conv.report_snapshot,
    messages: openaiMessages,
    attachments,
    onDelta: text => write({ type: 'delta', provider: 'openai', text }),
    onComplete: async result => {
      await persistCompletion(openaiRow, result);
      write({
        type: 'complete',
        provider: 'openai',
        messageId: openaiRow.id,
        model: result.model,
        costUsd: result.costUsd,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
      });
      finish();
    },
    onError: async err => {
      logger.warn('campaignAssistant.openai_stream_error', {
        userId, conversationId, error: err.message,
      });
      await persistFailure(openaiRow, err);
      write({ type: 'error', provider: 'openai', error: err.message });
      finish();
    },
  });

  campaignAssistant.streamClaude({
    report: conv.report_snapshot,
    messages: claudeMessages,
    attachments,
    onDelta: text => write({ type: 'delta', provider: 'claude', text }),
    onComplete: async result => {
      await persistCompletion(claudeRow, result);
      write({
        type: 'complete',
        provider: 'claude',
        messageId: claudeRow.id,
        model: result.model,
        costUsd: result.costUsd,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
      });
      finish();
    },
    onError: async err => {
      logger.warn('campaignAssistant.claude_stream_error', {
        userId, conversationId, error: err.message,
      });
      await persistFailure(claudeRow, err);
      write({ type: 'error', provider: 'claude', error: err.message });
      finish();
    },
  });
});

// ---------------------------------------------------------------------------
// POST /conversations/:id/one-shot — single-provider SSE stream, NOT persisted
//
// Used for inline "step-by-step" requests on an issue card. Body:
//   { prompt, provider }   where provider = 'openai' | 'claude'
//
// Streams just that provider's response, doesn't create a message row, no
// chat-turn side effect. Cheaper (one provider vs two), lighter (no DB
// writes), and keeps the followup response next to the issue it belongs
// to instead of pushing it to the bottom of the chat.
//
// SSE frames: {type:'start'} → {type:'delta',text} × N → {type:'complete',...}
//             or {type:'error',error} → {type:'done'}
// ---------------------------------------------------------------------------
router.post('/conversations/:id/one-shot', async (req, res) => {
  const userId = req.user.userId;
  const conversationId = req.params.id;
  const prompt = String(req.body?.prompt || '').trim().slice(0, MAX_USER_MESSAGE_CHARS);
  const provider = req.body?.provider === 'openai' ? 'openai' : 'claude';
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (!prompt && attachments.length === 0) return res.status(400).json({ error: 'prompt or attachment required' });

  const { data: conv, error } = await supabase
    .from('campaign_assistant_conversations')
    .select('id, report_snapshot')
    .eq('user_id', userId)
    .eq('id', conversationId)
    .single();
  if (error || !conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!conv.report_snapshot) return res.status(400).json({ error: 'Conversation is missing a report snapshot' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = obj => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {}
  };
  write({ type: 'start', provider });

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25_000);
  const closeOnce = (frame) => {
    clearInterval(heartbeat);
    write(frame);
    write({ type: 'done' });
    try { res.end(); } catch (_) {}
  };

  const streamFn = provider === 'openai'
    ? campaignAssistant.streamOpenAI
    : campaignAssistant.streamClaude;

  streamFn({
    report: conv.report_snapshot,
    messages: [{ role: 'user', content: prompt }],
    attachments,
    onDelta: text => write({ type: 'delta', text }),
    onComplete: result => closeOnce({
      type: 'complete',
      model: result.model,
      costUsd: result.costUsd,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
    }),
    onError: err => {
      logger.warn('campaignAssistant.one_shot_error', {
        userId, conversationId, provider, error: err.message,
      });
      closeOnce({ type: 'error', error: err.message });
    },
  });
});

// ---------------------------------------------------------------------------
// POST /messages/:id/rate — +1 / -1 / null
// ---------------------------------------------------------------------------
router.post('/messages/:id/rate', async (req, res) => {
  const rating = req.body?.rating;
  if (rating !== null && rating !== 1 && rating !== -1) {
    return res.status(400).json({ error: 'rating must be 1, -1, or null' });
  }
  try {
    // Enforce ownership: message must belong to a conversation owned by the user.
    const { data: msg, error: msgErr } = await supabase
      .from('campaign_assistant_messages')
      .select('id, conversation_id')
      .eq('id', req.params.id)
      .single();
    if (msgErr || !msg) return res.status(404).json({ error: 'Message not found' });

    const { data: conv, error: convErr } = await supabase
      .from('campaign_assistant_conversations')
      .select('id')
      .eq('id', msg.conversation_id)
      .eq('user_id', req.user.userId)
      .single();
    if (convErr || !conv) return res.status(404).json({ error: 'Message not found' });

    const { error: updErr } = await supabase
      .from('campaign_assistant_messages')
      .update({ rating })
      .eq('id', req.params.id);
    if (updErr) throw updErr;
    res.json({ ok: true, rating });
  } catch (err) {
    logger.error('campaignAssistant.rate_failed', {
      userId: req.user.userId, id: req.params.id, error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
