import axios from '../utils/axiosConfig';

// Thin client for /api/campaign-assistant.
//
// Chat is streamed via native fetch() because axios doesn't consume
// text/event-stream well. Everything else uses the standard axios instance.

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';
const TOKEN_KEY = 'gmb_token';

const listConversations = async () => {
  const res = await axios.get('/api/campaign-assistant/conversations');
  return res.data?.conversations || [];
};

const getConversation = async (id) => {
  const res = await axios.get(`/api/campaign-assistant/conversations/${id}`);
  return res.data;
};

const createConversation = async ({
  customerId, campaignId, campaignName,
  propertyId, firebasePropertyId, openAiAdsConnectionId,
  days, title,
}) => {
  const res = await axios.post('/api/campaign-assistant/conversations', {
    customerId, campaignId, campaignName,
    propertyId, firebasePropertyId, openAiAdsConnectionId,
    days, title,
  }, { timeout: 90_000 });
  return res.data;
};

const deleteConversation = async (id) => {
  const res = await axios.delete(`/api/campaign-assistant/conversations/${id}`);
  return res.data;
};

const rateMessage = async (id, rating) => {
  const res = await axios.post(`/api/campaign-assistant/messages/${id}/rate`, { rating });
  return res.data;
};

// Streaming chat. Consumes SSE via fetch() so we can pass an auth header
// (EventSource can't). Emits one call per frame to `onEvent`; frames are:
//   { type: 'start', turnIndex, openaiMessageId, claudeMessageId, userMessageId }
//   { type: 'delta', provider: 'openai'|'claude', text }
//   { type: 'complete', provider, messageId, model, costUsd, promptTokens, ... }
//   { type: 'error', provider, error }
//   { type: 'done' }
//
// Returns an AbortController — call .abort() to cancel client-side (server
// keeps writing to the closed socket; that's fine).
const streamChat = ({ conversationId, message, attachments, targets, onEvent, onError }) => {
  const controller = new AbortController();
  const token = localStorage.getItem(TOKEN_KEY);

  const run = async () => {
    let sawDone = false;
    try {
      const resp = await fetch(
        `${API_BASE}/api/campaign-assistant/conversations/${conversationId}/chat`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            message,
            attachments: attachments || [],
            targets: targets && targets.length ? targets : ['openai', 'claude'],
          }),
        }
      );
      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`Chat failed: ${resp.status} ${errText}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Split on \n\n frame separator; keep the tail in buf.
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const frame of parts) {
          for (const line of frame.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            try {
              const obj = JSON.parse(payload);
              onEvent(obj);
              if (obj.type === 'done') { sawDone = true; return; }
            } catch (_) { /* ignore malformed frame */ }
          }
        }
      }
      // Reader returned done=true without ever emitting a "done" frame —
      // means the server closed the connection (crash, proxy timeout,
      // network blip) mid-stream. Surface that so the UI doesn't sit on
      // "Thinking…" forever.
      if (!sawDone) {
        onEvent({ type: 'done', reason: 'connection_closed' });
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (onError) onError(err);
    }
  };

  run();
  return controller;
};

// One-shot single-provider stream. Used by the "Get step-by-step" button
// inside an issue card — one provider, no DB persistence, response
// rendered inline in the card. Same SSE frame protocol as streamChat.
const getCardMessages = async (conversationId, cardKey) => {
  const res = await axios.get(
    `/api/campaign-assistant/conversations/${conversationId}/cards/${encodeURIComponent(cardKey)}/messages`
  );
  return res.data?.messages || [];
};

const streamOneShot = ({ conversationId, prompt, provider, attachments, cardKey, onEvent, onError }) => {
  const controller = new AbortController();
  const token = localStorage.getItem(TOKEN_KEY);

  const run = async () => {
    let sawDone = false;
    try {
      const resp = await fetch(
        `${API_BASE}/api/campaign-assistant/conversations/${conversationId}/one-shot`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ prompt, provider, attachments: attachments || [], cardKey: cardKey || null }),
        }
      );
      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`One-shot failed: ${resp.status} ${errText}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const frame of parts) {
          for (const line of frame.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            try {
              const obj = JSON.parse(payload);
              onEvent(obj);
              if (obj.type === 'done') { sawDone = true; return; }
            } catch (_) { /* ignore malformed frame */ }
          }
        }
      }
      if (!sawDone) onEvent({ type: 'done', reason: 'connection_closed' });
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (onError) onError(err);
    }
  };

  run();
  return controller;
};

// ---- Action Plans ----

const listPlans = async (conversationId) => {
  const res = await axios.get(`/api/campaign-assistant/conversations/${conversationId}/plans`);
  return res.data?.plans || [];
};

const getPlan = async (planId) => {
  const res = await axios.get(`/api/campaign-assistant/plans/${planId}`);
  return res.data;
};

const generatePlan = async (conversationId) => {
  const res = await axios.post(
    `/api/campaign-assistant/conversations/${conversationId}/plans`,
    {},
    { timeout: 360_000 } // dialogue = 4 sequential rounds, ~2-4 min end-to-end
  );
  return res.data;
};

const updatePlanStep = async (stepId, patch) => {
  const res = await axios.patch(`/api/campaign-assistant/plan-steps/${stepId}`, patch);
  return res.data?.step;
};

const deletePlan = async (planId) => {
  const res = await axios.delete(`/api/campaign-assistant/plans/${planId}`);
  return res.data;
};

const pushBackPlanStep = async (stepId, feedback) => {
  const res = await axios.post(
    `/api/campaign-assistant/plan-steps/${stepId}/push-back`,
    { feedback }
  );
  return res.data;   // { step, chatPrompt }
};

const reportPlanStepResults = async (stepId, results) => {
  const res = await axios.post(
    `/api/campaign-assistant/plan-steps/${stepId}/report-results`,
    { results },
    { timeout: 90_000 }   // AI decision call takes 5-15s
  );
  return res.data;   // { step | null, deleted, decision: {action, reasoning, newTitle?, newDescription?} }
};

const applyPlanStep = async (stepId) => {
  const res = await axios.post(
    `/api/campaign-assistant/plan-steps/${stepId}/apply`,
    {},
    { timeout: 60_000 }
  );
  return res.data;   // { step, executed: { summary, result, noop? } }
};

const refreshSnapshot = async (conversationId) => {
  const res = await axios.post(
    `/api/campaign-assistant/conversations/${conversationId}/refresh-snapshot`,
    {},
    { timeout: 90_000 }
  );
  return res.data;   // { report_generated_at, snapshotMeta }
};

// Resolve a Meta diagnostic deep-link (?intent=meta_review&issueId=...) to
// the current-report issue context + a suggested user prompt. Server rejects
// arbitrary issue ids and looks the issue up in a fresh report against the
// user's Meta selection — never trusts URL data.
const resolveMetaReviewContext = async (issueId) => {
  const res = await axios.post('/api/campaign-assistant/meta-review-context', { issueId });
  return res.data;
};

const campaignAssistantService = {
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  rateMessage,
  streamChat,
  streamOneShot,
  getCardMessages,
  listPlans,
  getPlan,
  generatePlan,
  updatePlanStep,
  deletePlan,
  applyPlanStep,
  pushBackPlanStep,
  reportPlanStepResults,
  refreshSnapshot,
  resolveMetaReviewContext,
};

export default campaignAssistantService;
