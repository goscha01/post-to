import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Send, Bot, Sparkles, ThumbsUp, ThumbsDown, Trash2, Plus,
  Loader2, MessageSquare, AlertCircle, ChevronDown, ChevronRight, ListOrdered
} from 'lucide-react';
import googleAdsService from '../services/googleAdsService';
import analyticsService from '../services/analyticsService';
import connectionsService from '../services/connectionsService';
import campaignAssistantService from '../services/campaignAssistantService';

const DAYS_OPTIONS = [7, 14, 30, 60, 90];

const CampaignAssistant = () => {
  // Setup form state
  const [customers, setCustomers] = useState([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [campaigns, setCampaigns] = useState([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const [ga4Properties, setGa4Properties] = useState([]);
  const [selectedGa4PropertyId, setSelectedGa4PropertyId] = useState('');
  const [selectedFirebasePropertyId, setSelectedFirebasePropertyId] = useState('');
  const [openAiAdsConnections, setOpenAiAdsConnections] = useState([]);
  const [selectedOpenAiAdsConnectionId, setSelectedOpenAiAdsConnectionId] = useState('');
  const [days, setDays] = useState(30);
  const [creating, setCreating] = useState(false);
  const [setupError, setSetupError] = useState(null);

  // Conversation state
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [snapshotMeta, setSnapshotMeta] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [composer, setComposer] = useState('');
  const [showSnapshot, setShowSnapshot] = useState(true);

  const streamCtrlRef = useRef(null);
  const chatScrollRef = useRef(null);

  // -- Initial loads --
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setCustomersLoading(true);
      try {
        const [connectedCustomers, gaProps, connections] = await Promise.all([
          googleAdsService.listConnectedCustomers().catch(() => []),
          analyticsService.listConnectedProperties().catch(() => []),
          connectionsService.list().catch(() => []),
        ]);
        if (cancelled) return;
        // Only show customers the user has explicitly connected to Post To.
        // Drop error/revoked rows — "active" here means status is null|'active'
        // (older rows have no status set).
        // Only show "active" (or blank-status legacy) rows. Drop revoked/error.
        const isActive = (r) => {
          const s = (r?.status || '').toLowerCase();
          return s === '' || s === 'active';
        };
        setCustomers((connectedCustomers || []).filter(isActive));
        setGa4Properties((gaProps || []).filter(isActive));
        setOpenAiAdsConnections(
          (connections || []).filter(c => c.provider === 'openai_ads')
        );
      } catch (err) {
        console.error('Failed to load setup lists', err);
      } finally {
        if (!cancelled) setCustomersLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const convs = await campaignAssistantService.listConversations();
        if (!cancelled) setConversations(convs);
      } catch (err) {
        console.error('Failed to load conversations', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // -- Load campaigns for selected customer --
  useEffect(() => {
    if (!selectedCustomerId) {
      setCampaigns([]);
      setSelectedCampaignId('');
      return;
    }
    let cancelled = false;
    setCampaignsLoading(true);
    (async () => {
      try {
        const res = await googleAdsService.getCampaigns(selectedCustomerId, days);
        if (cancelled) return;
        setCampaigns(res?.campaigns || []);
      } catch (err) {
        if (!cancelled) setCampaigns([]);
      } finally {
        if (!cancelled) setCampaignsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCustomerId, days]);

  // -- Autoscroll chat on new content --
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  // -- Turn helpers --
  // Messages come in from DB in order (turn_index, created_at). Group them
  // by turn_index to render user + [openai, claude] triplets.
  const turns = useMemo(() => {
    const byTurn = new Map();
    for (const m of messages) {
      const t = m.turn_index ?? 0;
      if (!byTurn.has(t)) byTurn.set(t, { turnIndex: t, user: null, openai: null, claude: null });
      const entry = byTurn.get(t);
      if (m.role === 'user') entry.user = m;
      else if (m.provider === 'openai') entry.openai = m;
      else if (m.provider === 'claude') entry.claude = m;
    }
    return Array.from(byTurn.values()).sort((a, b) => a.turnIndex - b.turnIndex);
  }, [messages]);

  const selectedCustomer = customers.find(c =>
    (c.customerId || c.customer_id) === selectedCustomerId
  );
  const selectedCustomerEmail = (selectedCustomer?.ownerEmail || selectedCustomer?.owner_email || '').toLowerCase();
  const selectedCampaign = campaigns.find(c =>
    String(c.campaignId || c.id) === String(selectedCampaignId)
  );

  // -- Actions --
  const startNewAnalysis = useCallback(async () => {
    if (!selectedCustomerId || !selectedCampaignId) {
      setSetupError('Pick a customer and campaign first.');
      return;
    }
    setSetupError(null);
    setCreating(true);
    try {
      const res = await campaignAssistantService.createConversation({
        customerId: selectedCustomerId,
        campaignId: selectedCampaignId,
        campaignName: selectedCampaign?.name || null,
        propertyId: selectedGa4PropertyId || null,
        firebasePropertyId: selectedFirebasePropertyId || null,
        openAiAdsConnectionId: selectedOpenAiAdsConnectionId || null,
        days,
        title: selectedCampaign?.name || `Campaign ${selectedCampaignId}`,
      });
      const conv = res.conversation;
      setConversations(prev => [conv, ...prev]);
      setActiveConversation(conv);
      setSnapshotMeta(res.snapshotMeta);
      setMessages([]);
      // Fire the auto-analysis initial turn.
      await sendMessage(res.initialAnalysisPrompt, conv.id);
    } catch (err) {
      setSetupError(err.response?.data?.error || err.message || 'Failed to start analysis');
    } finally {
      setCreating(false);
    }
  }, [
    selectedCustomerId, selectedCampaignId, selectedGa4PropertyId,
    selectedFirebasePropertyId, selectedOpenAiAdsConnectionId, selectedCampaign, days,
  ]);

  const openConversation = useCallback(async (id) => {
    if (streaming) return;
    setLoadingConversation(true);
    try {
      const res = await campaignAssistantService.getConversation(id);
      setActiveConversation(res.conversation);
      setSnapshotMeta(res.snapshotMeta);
      setMessages(res.messages || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingConversation(false);
    }
  }, [streaming]);

  const deleteConversation = useCallback(async (id) => {
    if (!window.confirm('Delete this conversation?')) return;
    try {
      await campaignAssistantService.deleteConversation(id);
      setConversations(prev => prev.filter(c => c.id !== id));
      if (activeConversation?.id === id) {
        setActiveConversation(null);
        setMessages([]);
        setSnapshotMeta(null);
      }
    } catch (err) {
      console.error(err);
    }
  }, [activeConversation]);

  const sendMessage = useCallback(async (text, conversationId) => {
    const convId = conversationId || activeConversation?.id;
    if (!convId || !text.trim()) return;
    setStreaming(true);

    // Local optimistic placeholders — replaced with real DB rows once the
    // 'start' frame arrives (carries the messageIds). Provider messages
    // stream in via delta frames.
    const tempTurn = Math.max(0, ...messages.map(m => m.turn_index ?? 0)) + (messages.length ? 1 : 0);
    const optimisticUser = { id: `tmp-user-${Date.now()}`, turn_index: tempTurn, role: 'user', content: text, status: 'complete' };
    const optimisticOpenai = { id: `tmp-openai-${Date.now()}`, turn_index: tempTurn, role: 'assistant', provider: 'openai', content: '', status: 'streaming' };
    const optimisticClaude = { id: `tmp-claude-${Date.now()}`, turn_index: tempTurn, role: 'assistant', provider: 'claude', content: '', status: 'streaming' };
    setMessages(prev => [...prev, optimisticUser, optimisticOpenai, optimisticClaude]);

    let openaiId = optimisticOpenai.id;
    let claudeId = optimisticClaude.id;
    let userId = optimisticUser.id;

    streamCtrlRef.current = campaignAssistantService.streamChat({
      conversationId: convId,
      message: text,
      onEvent: (evt) => {
        if (evt.type === 'start') {
          // Swap temp ids for real DB ids.
          setMessages(prev => prev.map(m => {
            if (m.id === userId) return { ...m, id: evt.userMessageId };
            if (m.id === openaiId) return { ...m, id: evt.openaiMessageId, turn_index: evt.turnIndex };
            if (m.id === claudeId) return { ...m, id: evt.claudeMessageId, turn_index: evt.turnIndex };
            return m;
          }));
          userId = evt.userMessageId;
          openaiId = evt.openaiMessageId;
          claudeId = evt.claudeMessageId;
        } else if (evt.type === 'delta') {
          const targetId = evt.provider === 'openai' ? openaiId : claudeId;
          setMessages(prev => prev.map(m =>
            m.id === targetId ? { ...m, content: (m.content || '') + evt.text } : m
          ));
        } else if (evt.type === 'complete') {
          const targetId = evt.provider === 'openai' ? openaiId : claudeId;
          setMessages(prev => prev.map(m => m.id === targetId ? ({
            ...m,
            status: 'complete',
            model: evt.model,
            prompt_tokens: evt.promptTokens,
            completion_tokens: evt.completionTokens,
            cache_read_tokens: evt.cacheReadTokens,
            cache_write_tokens: evt.cacheWriteTokens,
            cost_usd: evt.costUsd,
          }) : m));
        } else if (evt.type === 'error') {
          const targetId = evt.provider === 'openai' ? openaiId : claudeId;
          setMessages(prev => prev.map(m => m.id === targetId ? ({
            ...m, status: 'failed', error: evt.error,
          }) : m));
        } else if (evt.type === 'done') {
          setStreaming(false);
          streamCtrlRef.current = null;
          // Safety net 1 — mark any still-'streaming' provider message
          // in this turn as complete/failed based on whether it has
          // content. Prevents "Thinking…" from sitting forever.
          setMessages(prev => prev.map(m => {
            if (m.status !== 'streaming') return m;
            if (m.id !== openaiId && m.id !== claudeId) return m;
            if (m.content && m.content.length > 0) {
              return { ...m, status: 'complete' };
            }
            return {
              ...m,
              status: 'failed',
              error: evt.reason === 'connection_closed'
                ? 'Connection dropped before response finished.'
                : 'No response from provider.',
            };
          }));
          // Safety net 2 — refetch from DB. The server always persists
          // every complete/error result to the messages table before
          // sending the done frame, so pulling the authoritative row
          // list here fixes any client drift (delta frame lost mid-
          // stream, closure over stale message ids, etc.).
          refetchActiveConversation(convId);
          // Bump the conversation to top of the sidebar list.
          setConversations(prev => {
            const cur = prev.find(c => c.id === convId);
            if (!cur) return prev;
            return [{ ...cur, updated_at: new Date().toISOString() }, ...prev.filter(c => c.id !== convId)];
          });
        }
      },
      onError: (err) => {
        setStreaming(false);
        streamCtrlRef.current = null;
        setMessages(prev => prev.map(m =>
          (m.id === openaiId || m.id === claudeId) && m.status === 'streaming'
            ? { ...m, status: 'failed', error: err.message }
            : m
        ));
      },
    });
  }, [activeConversation, messages]);

  const handleSend = useCallback(() => {
    if (!composer.trim() || streaming) return;
    const text = composer.trim();
    setComposer('');
    sendMessage(text);
  }, [composer, streaming, sendMessage]);

  // Reload conversation + messages from DB. Used as a safety net after the
  // chat stream 'done' event to reconcile any client-state drift (server
  // persisted 'complete' status but frontend never saw the frame, etc.).
  const refetchActiveConversation = useCallback(async (convId) => {
    if (!convId) return;
    try {
      const res = await campaignAssistantService.getConversation(convId);
      // Only apply if the user hasn't switched conversations in the meantime.
      setActiveConversation(prev => (prev && prev.id === convId ? res.conversation : prev));
      setMessages(prev => {
        // Merge: if a DB message has more content or a terminal status,
        // prefer the DB version. Keep any purely local temp rows.
        const byId = new Map(prev.map(m => [m.id, m]));
        for (const dbMsg of (res.messages || [])) {
          byId.set(dbMsg.id, { ...byId.get(dbMsg.id), ...dbMsg });
        }
        // Drop any local temp rows that never got a real id assigned.
        return Array.from(byId.values()).filter(m => !String(m.id || '').startsWith('tmp-'));
      });
    } catch (err) {
      console.warn('refetchActiveConversation failed', err);
    }
  }, []);

  const handleRate = useCallback(async (messageId, rating) => {
    // Optimistic toggle: click same rating twice to clear.
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId) return m;
      const next = m.rating === rating ? null : rating;
      return { ...m, rating: next };
    }));
    const target = messages.find(m => m.id === messageId);
    const nextRating = target?.rating === rating ? null : rating;
    try {
      await campaignAssistantService.rateMessage(messageId, nextRating);
    } catch (err) {
      console.error('Rating failed', err);
    }
  }, [messages]);

  return (
    <div className="min-h-[calc(100vh-6rem)] flex flex-col lg:flex-row gap-4">
      {/* Left rail: setup + conversations */}
      <div className="lg:w-80 flex-shrink-0 space-y-4">
        <SetupCard
          customers={customers}
          customersLoading={customersLoading}
          selectedCustomerId={selectedCustomerId}
          onSelectCustomer={setSelectedCustomerId}
          campaigns={campaigns}
          campaignsLoading={campaignsLoading}
          selectedCampaignId={selectedCampaignId}
          onSelectCampaign={setSelectedCampaignId}
          ga4Properties={ga4Properties}
          selectedGa4PropertyId={selectedGa4PropertyId}
          onSelectGa4Property={setSelectedGa4PropertyId}
          selectedFirebasePropertyId={selectedFirebasePropertyId}
          onSelectFirebaseProperty={setSelectedFirebasePropertyId}
          openAiAdsConnections={openAiAdsConnections}
          selectedOpenAiAdsConnectionId={selectedOpenAiAdsConnectionId}
          onSelectOpenAiAds={setSelectedOpenAiAdsConnectionId}
          days={days}
          onSelectDays={setDays}
          selectedCustomerEmail={selectedCustomerEmail}
          creating={creating}
          streaming={streaming}
          onStart={startNewAnalysis}
          error={setupError}
        />

        <ConversationsCard
          conversations={conversations}
          activeId={activeConversation?.id}
          onOpen={openConversation}
          onDelete={deleteConversation}
        />
      </div>

      {/* Right: chat */}
      <div className="flex-1 min-w-0 flex flex-col bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="border-b border-gray-200 p-4 flex items-center justify-between">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-gray-900 truncate">
              {activeConversation?.title || 'Campaign Assistant'}
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Get side-by-side campaign recommendations from OpenAI and Claude
            </p>
          </div>
          {activeConversation && (
            <div className="text-xs text-gray-500 hidden md:block">
              Customer {activeConversation.google_ads_customer_id} · {activeConversation.days}d
            </div>
          )}
        </div>

        {activeConversation && snapshotMeta && (
          <SnapshotBanner
            snapshotMeta={snapshotMeta}
            open={showSnapshot}
            onToggle={() => setShowSnapshot(v => !v)}
          />
        )}

        <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-4 space-y-6 bg-gray-50 min-h-[400px]">
          {!activeConversation && (
            <EmptyState />
          )}
          {loadingConversation && (
            <div className="flex items-center justify-center h-full text-gray-500">
              <Loader2 className="animate-spin mr-2" /> Loading conversation…
            </div>
          )}
          {activeConversation && turns.map(turn => (
            <TurnBlock
              key={turn.turnIndex}
              turn={turn}
              onRate={handleRate}
              conversationId={activeConversation.id}
            />
          ))}
        </div>

        <div className="border-t border-gray-200 p-3 bg-white">
          <div className="flex gap-2">
            <textarea
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={activeConversation
                ? 'Ask a follow-up question about this campaign…'
                : 'Start a new analysis first (pick a customer + campaign on the left)'}
              disabled={!activeConversation || streaming}
              rows={2}
              className="flex-1 resize-none border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-400"
            />
            <button
              onClick={handleSend}
              disabled={!activeConversation || streaming || !composer.trim()}
              className="px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Setup card (left)
// ---------------------------------------------------------------------------
const SetupCard = ({
  customers, customersLoading, selectedCustomerId, onSelectCustomer,
  campaigns, campaignsLoading, selectedCampaignId, onSelectCampaign,
  ga4Properties, selectedGa4PropertyId, onSelectGa4Property,
  selectedFirebasePropertyId, onSelectFirebaseProperty,
  openAiAdsConnections, selectedOpenAiAdsConnectionId, onSelectOpenAiAds,
  days, onSelectDays, selectedCustomerEmail,
  creating, streaming, onStart, error,
}) => {
  const busy = creating || streaming;
  const buttonLabel = creating
    ? 'Building report…'
    : streaming
    ? 'Streaming response…'
    : 'Run analysis';
  // Split GA4 into "matches the selected Ads customer's Google login" vs the
  // rest. Same list gets used by both the web GA4 and Firebase-linked GA4
  // pickers. Cross-owner is allowed by the backend (per-resource token
  // routing), but visually surfacing the matching ones removes the "why
  // are these different emails?" confusion.
  const ga4MatchesCustomer = (p) => {
    if (!selectedCustomerEmail) return false;
    return (p.ownerEmail || p.owner_email || '').toLowerCase() === selectedCustomerEmail;
  };
  const ga4Matching = ga4Properties.filter(ga4MatchesCustomer);
  const ga4Other = ga4Properties.filter(p => !ga4MatchesCustomer(p));

  const renderGa4Option = (p) => {
    const id = p.propertyId || p.property_id;
    const rawName = p.displayName || p.display_name;
    const email = p.ownerEmail || p.owner_email;
    const name = rawName || `Property ${id}`;
    const label = email ? `${name} — ${email}` : name;
    return <option key={id} value={id}>{label}</option>;
  };

  const renderGa4Options = () => {
    // No selected customer email OR only one group has entries: flat list.
    if (!selectedCustomerEmail || ga4Matching.length === 0 || ga4Other.length === 0) {
      return ga4Properties.map(renderGa4Option);
    }
    return (
      <>
        <optgroup label={`Same Google account as customer (${selectedCustomerEmail})`}>
          {ga4Matching.map(renderGa4Option)}
        </optgroup>
        <optgroup label="Other Google accounts">
          {ga4Other.map(renderGa4Option)}
        </optgroup>
      </>
    );
  };

  return (
  <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
    <div className="flex items-center gap-2 mb-1">
      <Sparkles className="h-4 w-4 text-primary-600" />
      <h2 className="font-semibold text-sm text-gray-900">New analysis</h2>
    </div>

    <Field
      label="Google Ads customer"
      hint={customers.length === 0 && !customersLoading
        ? 'No connected customers. Connect one on the Ads page first.'
        : undefined}
    >
      <select
        value={selectedCustomerId}
        onChange={(e) => onSelectCustomer(e.target.value)}
        disabled={customersLoading || busy || customers.length === 0}
        className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 disabled:bg-gray-50"
      >
        <option value="">
          {customersLoading ? 'Loading…' : '— Select customer —'}
        </option>
        {customers.map(c => {
          const id = c.customerId || c.customer_id;
          const rawName = c.descriptiveName || c.descriptive_name || c.display_name;
          const email = c.ownerEmail || c.owner_email;
          const name = rawName || `Customer ${id}`;
          const label = email ? `${name} — ${email}` : name;
          return <option key={id} value={id}>{label}</option>;
        })}
      </select>
      {selectedCustomerId && (
        <p className="text-[11px] text-gray-500 mt-1">
          Customer ID {selectedCustomerId}
        </p>
      )}
    </Field>

    <Field label="Campaign">
      <select
        value={selectedCampaignId}
        onChange={(e) => onSelectCampaign(e.target.value)}
        disabled={!selectedCustomerId || campaignsLoading || busy}
        className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 disabled:bg-gray-50"
      >
        <option value="">
          {campaignsLoading ? 'Loading campaigns…' : '— Select campaign —'}
        </option>
        {campaigns.map(c => {
          const id = c.campaignId || c.id;
          return (
            <option key={id} value={id}>
              {c.name} {c.status ? `· ${c.status}` : ''}
            </option>
          );
        })}
      </select>
    </Field>

    <Field label="Date range">
      <select
        value={days}
        onChange={(e) => onSelectDays(parseInt(e.target.value, 10))}
        disabled={busy}
        className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5"
      >
        {DAYS_OPTIONS.map(d => <option key={d} value={d}>{d} days</option>)}
      </select>
    </Field>

    <Field label="GA4 property (web)" optional>
      <select
        value={selectedGa4PropertyId}
        onChange={(e) => onSelectGa4Property(e.target.value)}
        disabled={busy}
        className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5"
      >
        <option value="">— None —</option>
        {renderGa4Options()}
      </select>
    </Field>

    <Field label="GA4 property (Firebase-linked)" optional hint="Pick the app-stream property if your Firebase project is linked to GA4">
      <select
        value={selectedFirebasePropertyId}
        onChange={(e) => onSelectFirebaseProperty(e.target.value)}
        disabled={busy}
        className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5"
      >
        <option value="">— None —</option>
        {renderGa4Options()}
      </select>
    </Field>

    {openAiAdsConnections.length > 0 && (
      <Field label="OpenAI Ads account" optional>
        <select
          value={selectedOpenAiAdsConnectionId}
          onChange={(e) => onSelectOpenAiAds(e.target.value)}
          disabled={busy}
          className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5"
        >
          <option value="">— None —</option>
          {openAiAdsConnections.map(c => (
            <option key={c.id} value={c.id}>
              {c.display_name || c.metadata?.ad_account_id || c.id}
            </option>
          ))}
        </select>
      </Field>
    )}

    {error && (
      <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md p-2">
        <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <span>{error}</span>
      </div>
    )}

    <button
      onClick={onStart}
      disabled={busy || !selectedCustomerId || !selectedCampaignId}
      className="w-full py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
      {buttonLabel}
    </button>
  </div>
  );
};

const Field = ({ label, children, optional, hint }) => (
  <div>
    <div className="flex items-baseline justify-between mb-1">
      <label className="text-xs font-medium text-gray-700">{label}</label>
      {optional && <span className="text-[10px] text-gray-400 uppercase">optional</span>}
    </div>
    {children}
    {hint && <p className="text-[11px] text-gray-500 mt-1">{hint}</p>}
  </div>
);

// ---------------------------------------------------------------------------
// Conversations list
// ---------------------------------------------------------------------------
const ConversationsCard = ({ conversations, activeId, onOpen, onDelete }) => (
  <div className="bg-white border border-gray-200 rounded-lg p-2">
    <div className="flex items-center gap-2 px-2 py-1.5">
      <MessageSquare className="h-4 w-4 text-gray-500" />
      <h2 className="font-semibold text-sm text-gray-900">Past analyses</h2>
    </div>
    {conversations.length === 0 && (
      <p className="text-xs text-gray-500 px-2 py-2">No analyses yet.</p>
    )}
    <ul className="space-y-0.5 max-h-[40vh] overflow-y-auto">
      {conversations.map(c => (
        <li key={c.id} className={`group flex items-center rounded-md px-2 py-1.5 cursor-pointer text-sm ${
          activeId === c.id ? 'bg-primary-50 text-primary-900' : 'hover:bg-gray-50 text-gray-700'
        }`}>
          <button onClick={() => onOpen(c.id)} className="flex-1 min-w-0 text-left">
            <div className="truncate">{c.title || `Campaign ${c.campaign_id}`}</div>
            <div className="text-[11px] text-gray-500">
              {new Date(c.updated_at || c.created_at).toLocaleString()}
            </div>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1"
            aria-label="Delete conversation"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  </div>
);

// ---------------------------------------------------------------------------
// Snapshot summary banner
// ---------------------------------------------------------------------------
const SnapshotBanner = ({ snapshotMeta, open, onToggle }) => {
  const s = snapshotMeta.summary || {};
  const alerts = snapshotMeta.alerts || {};
  const alertCount =
    (alerts.highSpendNoConversions?.length || 0) +
    (alerts.lowQualityKeywords?.length || 0) +
    (alerts.weakAds?.length || 0) +
    (alerts.landingPagesWithoutConversions?.length || 0) +
    (alerts.missingConversionTracking?.length || 0);
  const errs = snapshotMeta.errors || [];
  const fmtMoney = (v) => v == null ? '—' : `$${Number(v).toFixed(2)}`;
  const fmtPct = (v) => v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`;
  const fmtInt = (v) => v == null ? '—' : Math.round(Number(v)).toLocaleString();

  return (
    <div className="border-b border-gray-200 bg-gray-50">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Report snapshot
        <span className="text-gray-400">·</span>
        <span className="text-gray-500">
          {fmtMoney(s.cost)} spend · {fmtInt(s.clicks)} clicks · {fmtInt(s.conversions)} conv · {alertCount} alerts
        </span>
        {snapshotMeta.hasFirebase && <span className="ml-2 px-1.5 py-0.5 bg-orange-100 text-orange-800 rounded text-[10px]">Firebase</span>}
        {snapshotMeta.hasOpenAiAds && <span className="ml-1 px-1.5 py-0.5 bg-purple-100 text-purple-800 rounded text-[10px]">OpenAI Ads</span>}
        {errs.length > 0 && <span className="ml-1 px-1.5 py-0.5 bg-yellow-100 text-yellow-800 rounded text-[10px]">{errs.length} partial errors</span>}
      </button>
      {open && (
        <div className="px-4 pb-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <Stat label="Cost" value={fmtMoney(s.cost)} />
          <Stat label="Clicks" value={fmtInt(s.clicks)} />
          <Stat label="Impressions" value={fmtInt(s.impressions)} />
          <Stat label="CTR" value={fmtPct(s.ctr)} />
          <Stat label="Conversions" value={fmtInt(s.conversions)} />
          <Stat label="Conv. rate" value={fmtPct(s.conversionRate)} />
          <Stat label="CPA" value={fmtMoney(s.costPerConversion)} />
          <Stat label="ROAS" value={s.roas == null ? '—' : `${Number(s.roas).toFixed(2)}x`} />
        </div>
      )}
    </div>
  );
};

const Stat = ({ label, value }) => (
  <div>
    <div className="text-[10px] uppercase text-gray-500">{label}</div>
    <div className="font-semibold text-gray-900">{value}</div>
  </div>
);

// ---------------------------------------------------------------------------
// One conversational turn: user prompt + two side-by-side assistant columns
// ---------------------------------------------------------------------------
const TurnBlock = ({ turn, onRate, conversationId }) => (
  <div className="space-y-3">
    {turn.user && (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-primary-600 text-white rounded-lg px-4 py-2 text-sm whitespace-pre-wrap">
          {turn.user.content}
        </div>
      </div>
    )}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <ProviderColumn title="OpenAI" provider="openai" msg={turn.openai} onRate={onRate} conversationId={conversationId} accent="text-green-700" bg="bg-green-50" border="border-green-200" />
      <ProviderColumn title="Claude" provider="claude" msg={turn.claude} onRate={onRate} conversationId={conversationId} accent="text-orange-700" bg="bg-orange-50" border="border-orange-200" />
    </div>
  </div>
);

const ProviderColumn = ({ title, provider, msg, onRate, conversationId, accent, bg, border }) => {
  if (!msg) return null;
  const isStreaming = msg.status === 'streaming';
  const failed = msg.status === 'failed';
  return (
    <div className={`bg-white border ${border} rounded-lg p-3 flex flex-col`}>
      <div className="flex items-center justify-between mb-2">
        <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase ${accent}`}>
          <Bot className="h-3.5 w-3.5" />
          {title}
          {isStreaming && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
        </div>
        {msg.model && !isStreaming && (
          <span className="text-[10px] text-gray-400">{msg.model}</span>
        )}
      </div>

      {failed ? (
        <div className={`${bg} border ${border} rounded-md p-2 text-xs text-red-700 flex items-start gap-2`}>
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{msg.error || 'Provider failed'}</span>
        </div>
      ) : (
        <div className="flex-1">
          {msg.content
            ? <AssistantBody content={msg.content} provider={provider} conversationId={conversationId} />
            : (isStreaming ? <ThinkingIndicator /> : null)}
        </div>
      )}

      {!isStreaming && !failed && msg.content && (
        <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-100">
          <div className="text-[10px] text-gray-400">
            {msg.cost_usd != null && `$${Number(msg.cost_usd).toFixed(4)} · `}
            {msg.total_tokens != null && `${Math.round(msg.total_tokens)} tok`}
            {msg.cache_read_tokens > 0 && ` (${Math.round(msg.cache_read_tokens)} cached)`}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onRate(msg.id, 1)}
              className={`p-1 rounded hover:bg-gray-100 ${msg.rating === 1 ? 'text-green-600' : 'text-gray-400'}`}
              aria-label="Upvote"
            >
              <ThumbsUp className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onRate(msg.id, -1)}
              className={`p-1 rounded hover:bg-gray-100 ${msg.rating === -1 ? 'text-red-600' : 'text-gray-400'}`}
              aria-label="Downvote"
            >
              <ThumbsDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ThinkingIndicator — live-elapsed timer while a provider is streaming
// but hasn't emitted any text yet. Long-running Anthropic/OpenAI calls
// with big system prompts can take 30-90s to first token; without this
// the card just says "Thinking…" and looks stuck.
// ---------------------------------------------------------------------------
const ThinkingIndicator = () => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const hint = elapsed > 45
    ? 'Big report — models can take up to 2 min for the first token.'
    : elapsed > 15
    ? 'Waiting on the model to start streaming…'
    : 'Thinking…';
  return (
    <div className="flex items-center gap-2 text-sm text-gray-400">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>{hint}</span>
      <span className="text-[10px] text-gray-300">{elapsed}s</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// AssistantBody — parses the "## Title / **Fix:** ... / details" format
// into collapsible cards. Falls back to plain text for follow-up answers
// that don't use that format.
// ---------------------------------------------------------------------------

const HEADING_RE = /^##\s+(.+?)\s*$/m;
const FIX_RE = /^\s*(?:\*\*)?Fix(?:\*\*)?\s*:\s*(.+?)\s*$/im;

// Split content into sections keyed by "## <title>" headings. A prelude before
// the first heading (if any) becomes its own section with no title.
function splitSections(content) {
  const trimmed = (content || '').trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/\n(?=##\s+)/);
  const out = [];
  for (const part of parts) {
    const m = part.match(HEADING_RE);
    if (m) {
      out.push({ title: m[1], body: part.replace(HEADING_RE, '').trim() });
    } else if (part.trim()) {
      out.push({ title: null, body: part.trim() });
    }
  }
  return out;
}

// Extract the "Fix:" one-liner from a section body and return { fix, details }.
function splitFix(body) {
  const m = body.match(FIX_RE);
  if (!m) return { fix: null, details: body };
  const fix = m[1].trim();
  const details = body.replace(FIX_RE, '').trim();
  return { fix, details };
}

// Tiny inline markdown: **bold** + *italic* → React nodes. No links / code /
// tables — good enough for the small formatting the model uses in the Fix
// line and details paragraphs.
function renderInline(text) {
  const nodes = [];
  const re = /(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) nodes.push(<strong key={key++}>{m[1].slice(2, -2)}</strong>);
    else if (m[2]) nodes.push(<em key={key++}>{m[2].slice(1, -1)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Render a details body: preserves paragraphs and bullet lines.
const DetailsBody = ({ text }) => {
  const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());
  return (
    <div className="text-xs text-gray-700 space-y-2 leading-relaxed">
      {paragraphs.map((p, i) => {
        const lines = p.split('\n');
        const allBullets = lines.every(l => /^\s*[-*]\s+/.test(l));
        if (allBullets) {
          return (
            <ul key={i} className="list-disc pl-4 space-y-0.5">
              {lines.map((l, j) => (
                <li key={j}>{renderInline(l.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{renderInline(p)}</p>;
      })}
    </div>
  );
};

const IssueCard = ({ title, fix, details, provider, conversationId }) => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [stepsContent, setStepsContent] = useState('');
  const [stepsStatus, setStepsStatus] = useState('idle'); // idle | streaming | complete | failed
  const [stepsError, setStepsError] = useState(null);
  const stepsCtrlRef = useRef(null);
  const hasDetails = details && details.trim().length > 0;
  const canAskSteps = provider && conversationId && (title || fix);

  const startSteps = useCallback(() => {
    if (stepsStatus === 'streaming' || !canAskSteps) return;
    setStepsOpen(true);
    setStepsStatus('streaming');
    setStepsContent('');
    setStepsError(null);

    const parts = [];
    if (title) parts.push(`for the issue "${title}"`);
    if (fix) parts.push(`with the fix "${fix}"`);
    const scope = parts.join(' ') || 'the recommendation';
    const prompt = `Give me the exact click-by-click steps to implement ${scope}. Return a numbered list only — no explanation, no rationale, no data citations. If the fix belongs in a different tool (Google Ads, GA4, Firebase, landing page CMS, tag manager), state which tool at the top on its own line and give steps for that tool.`;

    let accumulated = '';
    stepsCtrlRef.current = campaignAssistantService.streamOneShot({
      conversationId,
      prompt,
      provider,
      onEvent: (evt) => {
        if (evt.type === 'delta') {
          accumulated += evt.text;
          setStepsContent(accumulated);
        } else if (evt.type === 'complete') {
          setStepsStatus('complete');
        } else if (evt.type === 'error') {
          setStepsStatus('failed');
          setStepsError(evt.error || 'Provider failed');
        } else if (evt.type === 'done') {
          stepsCtrlRef.current = null;
          setStepsStatus(prev => {
            if (prev === 'streaming') {
              return accumulated ? 'complete' : 'failed';
            }
            return prev;
          });
          if (!accumulated) {
            setStepsError(evt.reason === 'connection_closed'
              ? 'Connection dropped before response finished.'
              : 'No response from provider.');
          }
        }
      },
      onError: (err) => {
        stepsCtrlRef.current = null;
        setStepsStatus('failed');
        setStepsError(err.message || 'Request failed');
      },
    });
  }, [canAskSteps, conversationId, fix, provider, stepsStatus, title]);

  const providerLabel = provider === 'openai' ? 'OpenAI' : 'Claude';

  return (
    <div className="border border-gray-200 rounded-md bg-white">
      {title && (
        <div className="px-3 pt-2.5 text-sm font-semibold text-gray-900">
          {renderInline(title)}
        </div>
      )}
      {fix && (
        <div className="px-3 pt-1 pb-2.5 text-sm text-gray-800">
          <span className="font-medium text-primary-700">Fix:</span> {renderInline(fix)}
        </div>
      )}
      <div className="border-t border-gray-100 flex items-stretch divide-x divide-gray-100">
        {hasDetails && (
          <button
            onClick={() => setDetailsOpen(v => !v)}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] font-medium text-gray-500 hover:bg-gray-50"
          >
            {detailsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {detailsOpen ? 'Hide details' : 'Show details'}
          </button>
        )}
        {canAskSteps && (
          <button
            onClick={() => {
              if (stepsStatus === 'complete' || stepsStatus === 'failed') {
                setStepsOpen(v => !v);
              } else {
                startSteps();
              }
            }}
            disabled={stepsStatus === 'streaming'}
            title={`Ask ${providerLabel} for exact click-by-click steps`}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] font-medium text-primary-700 hover:bg-primary-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ListOrdered className="h-3 w-3" />
            {stepsStatus === 'streaming' ? 'Getting steps…' :
             stepsStatus === 'complete' && stepsOpen ? 'Hide steps' :
             stepsStatus === 'complete' ? 'Show steps' :
             stepsStatus === 'failed' ? 'Retry steps' :
             'Get step-by-step'}
          </button>
        )}
      </div>
      {detailsOpen && hasDetails && (
        <div className="px-3 pb-3 border-t border-gray-100"><DetailsBody text={details} /></div>
      )}
      {stepsOpen && (
        <div className="border-t border-primary-100 bg-primary-50 px-3 py-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-primary-800 flex items-center gap-1">
              <ListOrdered className="h-3 w-3" /> Step-by-step ({providerLabel})
            </div>
            <button
              onClick={() => setStepsOpen(false)}
              className="text-[11px] text-primary-700 hover:text-primary-900"
              aria-label="Close steps"
            >
              Close
            </button>
          </div>
          {stepsStatus === 'streaming' && !stepsContent && <ThinkingIndicator />}
          {stepsContent && <DetailsBody text={stepsContent} />}
          {stepsStatus === 'failed' && (
            <div className="text-xs text-red-700 flex items-start gap-1.5 mt-1">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>{stepsError || 'Failed to fetch steps.'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const AssistantBody = ({ content, provider, conversationId }) => {
  const sections = useMemo(() => splitSections(content), [content]);
  const hasHeadings = sections.some(s => s.title);
  if (!hasHeadings) {
    return <div className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{renderInline(content)}</div>;
  }
  return (
    <div className="space-y-2">
      {sections.map((s, i) => {
        const { fix, details } = splitFix(s.body);
        if (!s.title && !fix) {
          return (
            <p key={i} className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
              {renderInline(s.body)}
            </p>
          );
        }
        return (
          <IssueCard
            key={i}
            title={s.title}
            fix={fix}
            details={details}
            provider={provider}
            conversationId={conversationId}
          />
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
const EmptyState = () => (
  <div className="h-full flex flex-col items-center justify-center text-center text-gray-500 py-16">
    <Sparkles className="h-8 w-8 text-primary-500 mb-2" />
    <p className="text-sm font-medium text-gray-700">Pick a customer and campaign to start.</p>
    <p className="text-xs mt-1 max-w-md">
      The assistant pulls Google Ads + GA4 + (optionally) Firebase events and OpenAI Ads history,
      then asks OpenAI and Claude for recommendations side by side.
    </p>
  </div>
);

export default CampaignAssistant;
