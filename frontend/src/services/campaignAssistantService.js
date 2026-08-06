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
const streamChat = ({ conversationId, message, onEvent, onError }) => {
  const controller = new AbortController();
  const token = localStorage.getItem(TOKEN_KEY);

  const run = async () => {
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
          body: JSON.stringify({ message }),
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
              if (obj.type === 'done') return;
            } catch (_) { /* ignore malformed frame */ }
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (onError) onError(err);
    }
  };

  run();
  return controller;
};

const campaignAssistantService = {
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  rateMessage,
  streamChat,
};

export default campaignAssistantService;
