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

// Find every conversation the user owns for the same Ads customer + campaign.
// Used to widen per-card history so a user re-analyzing the same campaign
// weeks later still sees (and the model still remembers) the prior threads.
async function siblingConversationIds({ userId, customerId, campaignId }) {
  if (!customerId || !campaignId) return [];
  const { data, error } = await supabase
    .from('campaign_assistant_conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('google_ads_customer_id', customerId)
    .eq('campaign_id', campaignId);
  if (error || !data) return [];
  return data.map(r => r.id);
}

// Given a conversationId, return { customerId, campaignId, siblingIds } where
// siblingIds includes the conversation itself and every other conversation
// scoped to the same campaign. Enforces user ownership.
async function campaignScopeForConversation(userId, conversationId) {
  const { data: conv, error } = await supabase
    .from('campaign_assistant_conversations')
    .select('id, google_ads_customer_id, campaign_id')
    .eq('user_id', userId)
    .eq('id', conversationId)
    .single();
  if (error || !conv) return null;
  const siblings = await siblingConversationIds({
    userId,
    customerId: conv.google_ads_customer_id,
    campaignId: conv.campaign_id,
  });
  return {
    customerId: conv.google_ads_customer_id,
    campaignId: conv.campaign_id,
    siblingIds: siblings.length > 0 ? siblings : [conversationId],
  };
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

    // Main chat only — exclude card-scoped rows (they're loaded on-demand
    // by the IssueCard when its Ask panel opens).
    const { data: messages, error: msgErr } = await supabase
      .from('campaign_assistant_messages')
      .select('id, turn_index, role, provider, model, content, status, error, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, cost_usd, rating, created_at')
      .eq('conversation_id', conv.id)
      .is('card_key', null)
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
  // Which providers to fan out to. Default is both (preserves prior
  // behaviour). Anything unrecognized is dropped; empty → 400.
  const requestedTargets = Array.isArray(req.body?.targets) && req.body.targets.length > 0
    ? req.body.targets
    : ['openai', 'claude'];
  const targets = Array.from(new Set(requestedTargets.filter(t => t === 'openai' || t === 'claude')));
  if (targets.length === 0) {
    return res.status(400).json({ error: 'targets must include at least one of "openai" or "claude"' });
  }
  const wantOpenai = targets.includes('openai');
  const wantClaude = targets.includes('claude');

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

  // Load prior main-chat messages (exclude card-scoped ones) for provider history.
  const { data: priorMessages, error: histErr } = await supabase
    .from('campaign_assistant_messages')
    .select('id, turn_index, role, provider, content, status')
    .eq('conversation_id', conversationId)
    .is('card_key', null)
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

  // Insert placeholder assistant rows in 'streaming' status ONLY for the
  // requested targets — sending to just one provider shouldn't leave an
  // empty row for the other.
  const now = new Date().toISOString();
  const placeholderRows = [];
  if (wantOpenai) {
    placeholderRows.push({
      conversation_id: conversationId, turn_index: nextTurn,
      role: 'assistant', provider: 'openai', content: '', status: 'streaming', created_at: now,
    });
  }
  if (wantClaude) {
    placeholderRows.push({
      conversation_id: conversationId, turn_index: nextTurn,
      role: 'assistant', provider: 'claude', content: '', status: 'streaming',
      // +1ms so the (turn_index, created_at) sort is stable.
      created_at: new Date(Date.now() + 1).toISOString(),
    });
  }
  const { data: placeholders, error: phErr } = await supabase
    .from('campaign_assistant_messages')
    .insert(placeholderRows)
    .select();
  if (phErr) {
    return res.status(500).json({ error: phErr.message });
  }
  const openaiRow = placeholders.find(r => r.provider === 'openai') || null;
  const claudeRow = placeholders.find(r => r.provider === 'claude') || null;

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
  write({
    type: 'start',
    turnIndex: nextTurn,
    userMessageId: userRow.id,
    openaiMessageId: openaiRow?.id || null,
    claudeMessageId: claudeRow?.id || null,
    targets,
  });

  // Heartbeat every 25s so proxies don't close idle connection.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
  }, 25_000);

  const expectedFinishes = targets.length;
  let done = 0;
  const finish = () => {
    done += 1;
    if (done >= expectedFinishes) {
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

  // Kick off requested providers concurrently.
  if (wantOpenai) {
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
  }

  if (wantClaude) {
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
  }
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
  const cardKey = req.body?.cardKey ? String(req.body.cardKey).slice(0, 255) : null;
  if (!prompt && attachments.length === 0) return res.status(400).json({ error: 'prompt or attachment required' });

  const { data: conv, error } = await supabase
    .from('campaign_assistant_conversations')
    .select('id, report_snapshot')
    .eq('user_id', userId)
    .eq('id', conversationId)
    .single();
  if (error || !conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!conv.report_snapshot) return res.status(400).json({ error: 'Conversation is missing a report snapshot' });

  // Load prior card-scoped history if cardKey provided. History is scoped
  // to the CAMPAIGN (customer_id + campaign_id), not the individual
  // conversation — so re-running "Run analysis" on the same campaign next
  // week keeps every prior card thread available.
  let priorCardMessages = [];
  if (cardKey) {
    const scope = await campaignScopeForConversation(userId, conversationId);
    if (scope) {
      const { data } = await supabase
        .from('campaign_assistant_messages')
        .select('role, provider, content, status, created_at')
        .in('conversation_id', scope.siblingIds)
        .eq('card_key', cardKey)
        .eq('status', 'complete')
        .order('created_at', { ascending: true })
        .limit(80);
      // Filter to messages this provider should see (user turns + own assistant
      // turns; skip the other provider's replies to avoid style drift).
      priorCardMessages = (data || [])
        .filter(m => m.role === 'user' || m.provider === provider)
        .map(m => ({ role: m.role, content: m.content }));
    }
  }

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

  // Persist the user turn immediately (only when cardKey is provided; steps
  // without a cardKey stay ephemeral). Attachments are NOT persisted — they
  // travel with this turn only.
  let userMessageId = null;
  if (cardKey) {
    const { data: uRow, error: uErr } = await supabase
      .from('campaign_assistant_messages')
      .insert({
        conversation_id: conversationId,
        turn_index: null,
        role: 'user',
        content: prompt,
        card_key: cardKey,
        status: 'complete',
      })
      .select('id')
      .single();
    if (uErr) {
      logger.warn('campaignAssistant.one_shot_user_persist_failed', {
        userId, conversationId, cardKey, error: uErr.message,
      });
    } else {
      userMessageId = uRow.id;
      write({ type: 'user_message_id', id: userMessageId });
    }
  }

  const streamFn = provider === 'openai'
    ? campaignAssistant.streamOpenAI
    : campaignAssistant.streamClaude;

  streamFn({
    report: conv.report_snapshot,
    messages: [...priorCardMessages, { role: 'user', content: prompt }],
    attachments,
    onDelta: text => write({ type: 'delta', text }),
    onComplete: async result => {
      let assistantMessageId = null;
      if (cardKey) {
        const { data: aRow, error: aErr } = await supabase
          .from('campaign_assistant_messages')
          .insert({
            conversation_id: conversationId,
            turn_index: null,
            role: 'assistant',
            provider,
            content: result.content || '',
            card_key: cardKey,
            status: 'complete',
            model: result.model,
            prompt_tokens: result.promptTokens,
            completion_tokens: result.completionTokens,
            total_tokens: result.totalTokens,
            cache_read_tokens: result.cacheReadTokens,
            cache_write_tokens: result.cacheWriteTokens,
            cost_usd: result.costUsd,
          })
          .select('id')
          .single();
        if (!aErr) assistantMessageId = aRow.id;
      }
      closeOnce({
        type: 'complete',
        model: result.model,
        messageId: assistantMessageId,
        costUsd: result.costUsd,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
      });
    },
    onError: err => {
      logger.warn('campaignAssistant.one_shot_error', {
        userId, conversationId, provider, error: err.message,
      });
      closeOnce({ type: 'error', error: err.message });
    },
  });
});

// ---------------------------------------------------------------------------
// GET /conversations/:id/cards/:cardKey/messages — per-card history
// ---------------------------------------------------------------------------
router.get('/conversations/:id/cards/:cardKey/messages', async (req, res) => {
  const userId = req.user.userId;
  const conversationId = req.params.id;
  const cardKey = String(req.params.cardKey || '').slice(0, 255);
  if (!cardKey) return res.status(400).json({ error: 'cardKey required' });

  try {
    // Resolve the conversation to its campaign scope and enforce ownership.
    const scope = await campaignScopeForConversation(userId, conversationId);
    if (!scope) return res.status(404).json({ error: 'Not found' });

    // Card history is CAMPAIGN-scoped, not conversation-scoped: pull from
    // every conversation the user owns for the same customer+campaign so a
    // fresh "Run analysis" still inherits prior sessions' per-card threads.
    const { data: messages, error: msgErr } = await supabase
      .from('campaign_assistant_messages')
      .select('id, conversation_id, role, provider, content, model, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, cost_usd, status, created_at')
      .in('conversation_id', scope.siblingIds)
      .eq('card_key', cardKey)
      .order('created_at', { ascending: true });
    if (msgErr) throw msgErr;
    res.json({
      messages: messages || [],
      scope: {
        customerId: scope.customerId,
        campaignId: scope.campaignId,
        siblingConversationCount: scope.siblingIds.length,
      },
    });
  } catch (err) {
    logger.error('campaignAssistant.card_messages_failed', {
      userId, conversationId, cardKey, error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
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

// ---------------------------------------------------------------------------
// Action Plans
// ---------------------------------------------------------------------------

// Build a plain-text chronological transcript of the whole conversation
// (main-chat linear turns + all card-scoped Ask/Steps threads) to feed the
// synthesis model. Message ordering follows created_at.
async function buildFullTranscript(conversationId) {
  const { data: allMessages, error } = await supabase
    .from('campaign_assistant_messages')
    .select('role, provider, content, card_key, turn_index, created_at')
    .eq('conversation_id', conversationId)
    .eq('status', 'complete')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load messages: ${error.message}`);
  const rows = allMessages || [];

  const lines = [];
  for (const m of rows) {
    const who = m.role === 'user'
      ? 'USER'
      : `ASSISTANT (${m.provider || 'unknown'})`;
    const scope = m.card_key ? ` [card: ${m.card_key}]` : '';
    lines.push(`--- ${who}${scope} @ ${m.created_at} ---`);
    lines.push(m.content || '');
    lines.push('');
  }
  return lines.join('\n');
}

// POST /conversations/:id/plans — synthesize + persist a new consensus plan
router.post('/conversations/:id/plans', async (req, res) => {
  const userId = req.user.userId;
  const conversationId = req.params.id;
  const t0 = Date.now();

  try {
    const { data: conv, error: convErr } = await supabase
      .from('campaign_assistant_conversations')
      .select('id, report_snapshot, title')
      .eq('user_id', userId)
      .eq('id', conversationId)
      .single();
    if (convErr || !conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!conv.report_snapshot) return res.status(400).json({ error: 'Conversation is missing a report snapshot' });

    const transcript = await buildFullTranscript(conversationId);
    if (!transcript.trim()) {
      return res.status(400).json({ error: 'Nothing to synthesize — no completed messages yet' });
    }

    const result = await campaignAssistant.synthesizeDialoguePlan({
      report: conv.report_snapshot,
      transcript,
    });

    // Stash the whole dialogue (openaiDraft → claudeCritique → openaiRevision
    // → final) as JSON in raw_response for audit. Old plans stored plain
    // text; the GET handler tolerates both.
    const rawResponseAudit = JSON.stringify({
      final: result.rawResponse,
      dialogue: result.dialogue || null,
      failures: result.failures || null,
      degraded: !!result.degraded,
      convergence_notes: result.plan?.convergence_notes || null,
    });

    // Persist plan.
    const { data: planRow, error: planErr } = await supabase
      .from('campaign_assistant_action_plans')
      .insert({
        user_id: userId,
        conversation_id: conversationId,
        title: result.plan.title || `Plan for ${conv.title || 'campaign'}`,
        summary: result.plan.summary || null,
        generated_by: result.provider,           // 'consensus' | 'openai' | 'claude' (single-provider fallback)
        model: result.model,
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.totalTokens,
        cache_read_tokens: result.usage.cacheReadTokens,
        cache_write_tokens: result.usage.cacheWriteTokens,
        cost_usd: result.usage.costUsd,
        raw_response: rawResponseAudit,
      })
      .select()
      .single();
    if (planErr) throw new Error(`Failed to persist plan: ${planErr.message}`);

    // Persist steps.
    const stepRows = (result.plan.steps || []).map((s, i) => ({
      plan_id: planRow.id,
      position: i,
      title: s.title,
      description: s.description,
      type: s.type,
      action_type: s.action_type,
      action_params: s.action_params,
      priority: s.priority,
      effort: s.effort,
    }));
    let steps = [];
    if (stepRows.length > 0) {
      const { data: insertedSteps, error: stepsErr } = await supabase
        .from('campaign_assistant_action_plan_steps')
        .insert(stepRows)
        .select();
      if (stepsErr) throw new Error(`Failed to persist plan steps: ${stepsErr.message}`);
      steps = insertedSteps || [];
    }

    logger.info('campaignAssistant.plan_created', {
      userId,
      conversationId,
      planId: planRow.id,
      provider: result.provider,
      model: result.model,
      stepCount: steps.length,
      costUsd: result.usage.costUsd,
      degraded: !!result.degraded,
      duration_ms: Date.now() - t0,
    });

    // Extract audit fields onto the top-level response so the frontend can
    // render "consensus" badges and convergence notes without re-parsing
    // raw_response.
    const planWithAudit = {
      ...planRow,
      convergence_notes: result.plan?.convergence_notes || null,
      degraded: !!result.degraded,
    };
    res.json({ plan: planWithAudit, steps });
  } catch (err) {
    logger.error('campaignAssistant.plan_create_failed', {
      userId, conversationId, error: err.message, duration_ms: Date.now() - t0,
    });
    res.status(err.status || 500).json({ error: err.message || 'Failed to generate plan' });
  }
});

// GET /conversations/:id/plans — list plans for a conversation
router.get('/conversations/:id/plans', async (req, res) => {
  try {
    // Ownership check.
    const { data: conv, error: convErr } = await supabase
      .from('campaign_assistant_conversations')
      .select('id')
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id)
      .single();
    if (convErr || !conv) return res.status(404).json({ error: 'Not found' });

    const { data: plans, error } = await supabase
      .from('campaign_assistant_action_plans')
      .select('id, title, summary, generated_by, model, cost_usd, status, created_at, updated_at')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ plans: plans || [] });
  } catch (err) {
    logger.error('campaignAssistant.plans_list_failed', {
      userId: req.user.userId, conversationId: req.params.id, error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

// GET /plans/:planId — plan + its steps
router.get('/plans/:planId', async (req, res) => {
  try {
    const { data: plan, error: planErr } = await supabase
      .from('campaign_assistant_action_plans')
      .select('*')
      .eq('user_id', req.user.userId)
      .eq('id', req.params.planId)
      .single();
    if (planErr || !plan) return res.status(404).json({ error: 'Plan not found' });

    const { data: steps, error: stepsErr } = await supabase
      .from('campaign_assistant_action_plan_steps')
      .select('*')
      .eq('plan_id', plan.id)
      .order('position', { ascending: true });
    if (stepsErr) throw stepsErr;

    // Don't ship the full raw_response back — it's an audit artifact,
    // potentially large. But do peel off convergence_notes + degraded from
    // it so the frontend can render the consensus surface.
    const { raw_response, ...planPublic } = plan;
    let convergenceNotes = null;
    let degraded = false;
    if (raw_response) {
      try {
        const parsed = JSON.parse(raw_response);
        convergenceNotes = parsed?.convergence_notes || null;
        degraded = !!parsed?.degraded;
      } catch (_) { /* legacy single-provider plans stored plain text — ignore */ }
    }
    res.json({
      plan: { ...planPublic, convergence_notes: convergenceNotes, degraded },
      steps: steps || [],
    });
  } catch (err) {
    logger.error('campaignAssistant.plan_get_failed', {
      userId: req.user.userId, planId: req.params.planId, error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /plan-steps/:stepId — update status or notes
router.patch('/plan-steps/:stepId', async (req, res) => {
  const allowedStatuses = new Set(['pending', 'done', 'skipped', 'applied', 'failed']);
  const patch = {};
  if (req.body?.status !== undefined) {
    if (!allowedStatuses.has(req.body.status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    patch.status = req.body.status;
    if (req.body.status === 'applied') patch.applied_at = new Date().toISOString();
  }
  if (req.body?.notes !== undefined) {
    patch.notes = String(req.body.notes).slice(0, 8000);
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'no fields to update' });
  }

  try {
    // Ownership check: step → plan → conversation.user_id
    const { data: step, error: stepErr } = await supabase
      .from('campaign_assistant_action_plan_steps')
      .select('id, plan_id, campaign_assistant_action_plans!inner(user_id)')
      .eq('id', req.params.stepId)
      .single();
    if (stepErr || !step) return res.status(404).json({ error: 'Step not found' });
    if (step.campaign_assistant_action_plans?.user_id !== req.user.userId) {
      return res.status(404).json({ error: 'Step not found' });
    }

    const { data: updated, error: updErr } = await supabase
      .from('campaign_assistant_action_plan_steps')
      .update(patch)
      .eq('id', req.params.stepId)
      .select()
      .single();
    if (updErr) throw updErr;
    res.json({ step: updated });
  } catch (err) {
    logger.error('campaignAssistant.plan_step_update_failed', {
      userId: req.user.userId, stepId: req.params.stepId, error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /plan-steps/:stepId/apply — dispatch a plan step's action to the
// right Google Ads mutation. Tier 1 supported action_types:
//   - add_negative_keywords  (campaign-level, reversible)
// Other action_types return 400 "not implemented" for now. Extend by
// adding cases to the switch below.
// ---------------------------------------------------------------------------

const googleAdsSvc = require('../services/googleAdsService');
const analyticsSvc = require('../services/analyticsService');

router.post('/plan-steps/:stepId/apply', async (req, res) => {
  const userId = req.user.userId;
  const stepId = req.params.stepId;
  const t0 = Date.now();

  try {
    // Load step + owning plan + owning conversation. Enforce user ownership
    // through the conversation.
    const { data: step, error: stepErr } = await supabase
      .from('campaign_assistant_action_plan_steps')
      .select('id, plan_id, title, type, action_type, action_params, status')
      .eq('id', stepId)
      .single();
    if (stepErr || !step) return res.status(404).json({ error: 'Step not found' });

    const { data: plan, error: planErr } = await supabase
      .from('campaign_assistant_action_plans')
      .select('id, conversation_id, user_id')
      .eq('id', step.plan_id)
      .single();
    if (planErr || !plan || plan.user_id !== userId) {
      return res.status(404).json({ error: 'Step not found' });
    }

    if (step.type !== 'google_ads_action' && step.type !== 'app_code_change') {
      return res.status(400).json({ error: `Cannot apply step of type "${step.type}"` });
    }
    if (step.status === 'applied') {
      return res.status(409).json({ error: 'Step already applied' });
    }

    // Resolve customer + property + tokens via the conversation this plan
    // belongs to. Which of these we actually need depends on step.action_type;
    // we resolve all up-front to keep the switch simple.
    const { data: conv, error: convErr } = await supabase
      .from('campaign_assistant_conversations')
      .select('id, google_ads_customer_id, google_ads_login_customer_id, ga4_property_id, ga4_app_property_id')
      .eq('id', plan.conversation_id)
      .single();
    if (convErr || !conv) return res.status(404).json({ error: 'Underlying conversation not found' });

    // Dispatch on action_type. Each case: validate params, call service,
    // shape the result for both the client and the audit log. Different
    // action types need different tokens (Ads owner vs GA4 owner), so
    // resolution happens inside each case.
    let executed;
    try {
      switch (step.action_type) {
        case 'add_negative_keywords': {
          const adsCustomer = await resolveAdsCustomer(userId, conv.google_ads_customer_id);
          if (!adsCustomer.customerId) throw new Error('No connected Google Ads customer for this conversation');
          const accessToken = await tokenForOwner(req, adsCustomer.ownerGoogleId);
          if (!accessToken) throw new Error('No Google access token available; reconnect Google Business.');
          const loginCustomerId = adsCustomer.loginCustomerId || conv.google_ads_login_customer_id || null;
          const params = step.action_params || {};
          const keywords = Array.isArray(params.keywords) ? params.keywords : [];
          const matchType = params.matchType || params.match_type || 'BROAD';
          const campaignId = params.campaignId || params.campaign_id || null;
          if (!campaignId) throw new Error('action_params.campaignId is required');
          if (keywords.length === 0) throw new Error('action_params.keywords must be a non-empty array');
          const result = await googleAdsSvc.addCampaignNegativeKeywords({
            accessToken,
            customerId: adsCustomer.customerId,
            loginCustomerId,
            campaignId,
            keywords,
            matchType,
          });
          executed = {
            summary: `Added ${result.created.length} negative keyword(s) to campaign ${campaignId} (${result.skipped.length} skipped).`,
            result,
          };
          break;
        }
        case 'pause_campaign': {
          const adsCustomer = await resolveAdsCustomer(userId, conv.google_ads_customer_id);
          if (!adsCustomer.customerId) throw new Error('No connected Google Ads customer for this conversation');
          const accessToken = await tokenForOwner(req, adsCustomer.ownerGoogleId);
          if (!accessToken) throw new Error('No Google access token available; reconnect Google Business.');
          const loginCustomerId = adsCustomer.loginCustomerId || conv.google_ads_login_customer_id || null;
          const params = step.action_params || {};
          const campaignId = params.campaignId || params.campaign_id || null;
          if (!campaignId) throw new Error('action_params.campaignId is required');
          const result = await googleAdsSvc.pauseCampaign({
            accessToken,
            customerId: adsCustomer.customerId,
            loginCustomerId,
            campaignId,
          });
          executed = {
            summary: `Paused campaign ${campaignId}. Re-enable in Google Ads UI → Campaigns → toggle status.`,
            result,
          };
          break;
        }
        case 'set_primary_conversion_action': {
          const adsCustomer = await resolveAdsCustomer(userId, conv.google_ads_customer_id);
          if (!adsCustomer.customerId) throw new Error('No connected Google Ads customer for this conversation');
          const accessToken = await tokenForOwner(req, adsCustomer.ownerGoogleId);
          if (!accessToken) throw new Error('No Google access token available; reconnect Google Business.');
          const loginCustomerId = adsCustomer.loginCustomerId || conv.google_ads_login_customer_id || null;
          const params = step.action_params || {};
          const rn = params.conversionActionResourceName || params.conversion_action_resource_name || null;
          if (!rn) throw new Error('action_params.conversionActionResourceName is required (format: customers/<cid>/conversionActions/<id>)');
          const result = await googleAdsSvc.setConversionActionPrimary({
            accessToken,
            customerId: adsCustomer.customerId,
            loginCustomerId,
            conversionActionResourceName: rn,
          });
          executed = {
            summary: `Marked ${rn} as primary conversion action (account-level — affects every campaign not overriding via campaign_conversion_goal).`,
            result,
          };
          break;
        }
        case 'set_campaign_budget': {
          const adsCustomer = await resolveAdsCustomer(userId, conv.google_ads_customer_id);
          if (!adsCustomer.customerId) throw new Error('No connected Google Ads customer for this conversation');
          const accessToken = await tokenForOwner(req, adsCustomer.ownerGoogleId);
          if (!accessToken) throw new Error('No Google access token available; reconnect Google Business.');
          const loginCustomerId = adsCustomer.loginCustomerId || conv.google_ads_login_customer_id || null;
          const params = step.action_params || {};
          const campaignId = params.campaignId || params.campaign_id || null;
          const dailyBudgetUsd = Number(params.dailyBudgetUsd ?? params.daily_budget_usd);
          if (!campaignId) throw new Error('action_params.campaignId is required');
          if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0) throw new Error('action_params.dailyBudgetUsd must be a positive number');
          const result = await googleAdsSvc.setCampaignDailyBudget({
            accessToken,
            customerId: adsCustomer.customerId,
            loginCustomerId,
            campaignId,
            dailyBudgetUsd,
          });
          executed = {
            summary: `Set campaign ${campaignId} daily budget: $${result.previousDailyBudgetUsd.toFixed(2)} → $${result.newDailyBudgetUsd.toFixed(2)}.`,
            result,
          };
          break;
        }
        case 'mark_ga4_conversion_event': {
          const params = step.action_params || {};
          // Prefer explicit propertyId in action_params; fall back to the
          // conversation's linked GA4 property (web) then Firebase-linked.
          const propertyIdRaw = params.propertyId || params.property_id
            || conv.ga4_property_id || conv.ga4_app_property_id || null;
          const eventName = params.eventName || params.event_name || null;
          if (!propertyIdRaw) throw new Error('action_params.propertyId is required (or the conversation must have a linked GA4 property)');
          if (!eventName) throw new Error('action_params.eventName is required');
          // Resolve the GA4 property row to get the owning Google identity.
          const ga4Prop = await resolveGa4Property(userId, propertyIdRaw);
          if (!ga4Prop.propertyId) throw new Error(`GA4 property ${propertyIdRaw} is not connected to this account`);
          const accessToken = await tokenForOwner(req, ga4Prop.ownerGoogleId);
          if (!accessToken) throw new Error('No Google access token available; reconnect Google Business.');
          try {
            const result = await analyticsSvc.markConversionEvent(accessToken, ga4Prop.propertyId, eventName);
            executed = {
              summary: `Marked "${eventName}" as a conversion event on GA4 property ${ga4Prop.propertyId}.`,
              result,
            };
          } catch (e) {
            // Detect the "user hasn't granted analytics.edit yet" case and
            // surface a friendly reconnect message.
            const msg = e?.response?.data?.error?.message || e?.errors?.[0]?.message || e?.message || 'GA4 API error';
            if (/insufficient|scope|forbidden|permission/i.test(msg) && /analytics\.edit|edit/i.test(msg + ' ' + JSON.stringify(e?.response?.data || {}))) {
              const scopeErr = new Error('Google account does not have the analytics.edit scope. Reconnect Google Business to grant it.');
              scopeErr.code = 'SCOPE_MISSING';
              throw scopeErr;
            }
            throw new Error(msg);
          }
          break;
        }
        default:
          return res.status(400).json({
            error: `Action type "${step.action_type}" is recognised in the plan schema but not yet wired to a live mutation. Implemented: add_negative_keywords, pause_campaign, set_primary_conversion_action, set_campaign_budget, mark_ga4_conversion_event.`,
          });
      }
    } catch (mutationErr) {
      // Persist failure onto the step so the UI can show it.
      const errMsg = mutationErr?.response?.data?.error?.message || mutationErr?.message || 'unknown error';
      await supabase
        .from('campaign_assistant_action_plan_steps')
        .update({
          status: 'failed',
          applied_error: String(errMsg).slice(0, 4000),
        })
        .eq('id', stepId);
      logger.error('campaignAssistant.plan_step_apply_failed', {
        userId, stepId, actionType: step.action_type, error: errMsg,
      });
      return res.status(mutationErr?.response?.status || 500).json({
        error: errMsg,
        actionType: step.action_type,
      });
    }

    // Success — mark step applied, stash the execution result in notes so
    // the user can see what actually happened (e.g. skipped keywords with
    // reasons).
    const applyNote = `[Applied ${new Date().toISOString()}] ${executed.summary}`;
    const { data: updated } = await supabase
      .from('campaign_assistant_action_plan_steps')
      .update({
        status: 'applied',
        applied_at: new Date().toISOString(),
        applied_error: null,
        notes: applyNote,
      })
      .eq('id', stepId)
      .select()
      .single();

    logger.info('campaignAssistant.plan_step_applied', {
      userId, stepId, actionType: step.action_type,
      duration_ms: Date.now() - t0,
    });

    res.json({ step: updated, executed });
  } catch (err) {
    logger.error('campaignAssistant.plan_step_apply_unhandled', {
      userId, stepId, error: err.message,
    });
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /plans/:planId — cascade drops steps via ON DELETE CASCADE
router.delete('/plans/:planId', async (req, res) => {
  try {
    const { error } = await supabase
      .from('campaign_assistant_action_plans')
      .delete()
      .eq('user_id', req.user.userId)
      .eq('id', req.params.planId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    logger.error('campaignAssistant.plan_delete_failed', {
      userId: req.user.userId, planId: req.params.planId, error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
