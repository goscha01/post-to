import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Send, Bot, Sparkles, ThumbsUp, ThumbsDown, Trash2, Plus,
  Loader2, MessageSquare, AlertCircle, ChevronDown, ChevronRight, ListOrdered,
  Paperclip, X, HelpCircle, Image as ImageIcon, Copy, Check,
  ClipboardList, RefreshCw, Circle
} from 'lucide-react';
import googleAdsService from '../services/googleAdsService';
import analyticsService from '../services/analyticsService';
import connectionsService from '../services/connectionsService';
import campaignAssistantService from '../services/campaignAssistantService';

const DAYS_OPTIONS = [7, 14, 30, 60, 90];

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;   // 5 MB per file
const MAX_ATTACHMENTS_PER_TURN = 4;

// Convert a File/Blob to base64 (without the "data:...;base64," prefix) and
// return the metadata we need to ship it upstream to OpenAI/Claude.
async function fileToAttachment(file) {
  if (!file) return null;
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error(`Unsupported file type ${file.type || '(unknown)'}. Use PNG, JPEG, WebP, or GIF.`);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File is ${(file.size / 1024 / 1024).toFixed(1)}MB — max 5MB.`);
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('Failed to read file'));
    r.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'image',
    mediaType: file.type,
    name: file.name || 'pasted-image',
    sizeBytes: file.size,
    data: base64,
    previewUrl: dataUrl,
  };
}

// Small strip of thumbnails above a composer. Removes on X click.
const AttachmentStrip = ({ items, onRemove }) => {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {items.map(a => (
        <div key={a.id} className="relative group">
          <img
            src={a.previewUrl}
            alt={a.name}
            className="h-14 w-14 object-cover rounded border border-gray-300"
          />
          <button
            onClick={() => onRemove(a.id)}
            className="absolute -top-1 -right-1 bg-white border border-gray-300 rounded-full p-0.5 shadow-sm opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:border-red-300"
            aria-label={`Remove ${a.name}`}
          >
            <X className="h-3 w-3 text-gray-600" />
          </button>
        </div>
      ))}
    </div>
  );
};

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
  const [composerAttachments, setComposerAttachments] = useState([]);
  const [composerError, setComposerError] = useState(null);
  const [showSnapshot, setShowSnapshot] = useState(true);

  // Action plan state — latest plan for the active conversation, its steps,
  // and generation status. Plans persist in DB; user can regenerate to
  // supersede the previous one after more discussion. Generation always
  // runs both providers in parallel + a reconciliation pass; user does
  // NOT pick a provider — the plan is a joint consensus.
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [latestPlan, setLatestPlan] = useState(null);       // { plan, steps }
  const [planPanelOpen, setPlanPanelOpen] = useState(true);

  const streamCtrlRef = useRef(null);
  const chatScrollRef = useRef(null);
  const fileInputRef = useRef(null);

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

  // -- Action plan handlers (declared BEFORE openConversation because
  // openConversation's dep array references loadLatestPlan) --
  const loadLatestPlan = useCallback(async (convId) => {
    if (!convId) return;
    try {
      const plans = await campaignAssistantService.listPlans(convId);
      if (!plans || plans.length === 0) {
        setLatestPlan(null);
        return;
      }
      const full = await campaignAssistantService.getPlan(plans[0].id);
      setLatestPlan(full);
    } catch (err) {
      console.warn('loadLatestPlan failed', err);
    }
  }, []);

  const generatePlan = useCallback(async () => {
    if (!activeConversation) return;
    setPlanLoading(true);
    setPlanError(null);
    try {
      // Auto-refresh the snapshot first so the AI sees CURRENT Google Ads
      // + GA4 state (respecting whatever steps have been applied since
      // last snapshot). Failures here are non-fatal — regen falls back
      // to the existing snapshot.
      try {
        const refreshRes = await campaignAssistantService.refreshSnapshot(activeConversation.id);
        setSnapshotMeta(refreshRes.snapshotMeta);
        setActiveConversation(prev => prev && { ...prev, report_generated_at: refreshRes.report_generated_at });
      } catch (refreshErr) {
        console.warn('Pre-regen snapshot refresh failed; regenerating against existing snapshot', refreshErr);
      }
      const res = await campaignAssistantService.generatePlan(activeConversation.id);
      setLatestPlan(res);
      setPlanPanelOpen(true);
    } catch (err) {
      setPlanError(err.response?.data?.error || err.message || 'Failed to generate plan');
    } finally {
      setPlanLoading(false);
    }
  }, [activeConversation]);

  const toggleStepStatus = useCallback(async (stepId, currentStatus) => {
    const nextStatus = currentStatus === 'done' ? 'pending' : 'done';
    // Optimistic update.
    setLatestPlan(prev => prev && ({
      ...prev,
      steps: prev.steps.map(s => s.id === stepId ? { ...s, status: nextStatus } : s),
    }));
    try {
      await campaignAssistantService.updatePlanStep(stepId, { status: nextStatus });
    } catch (err) {
      // Rollback on failure.
      setLatestPlan(prev => prev && ({
        ...prev,
        steps: prev.steps.map(s => s.id === stepId ? { ...s, status: currentStatus } : s),
      }));
    }
  }, []);

  const updateStepNotes = useCallback(async (stepId, notes) => {
    setLatestPlan(prev => prev && ({
      ...prev,
      steps: prev.steps.map(s => s.id === stepId ? { ...s, notes } : s),
    }));
    try {
      await campaignAssistantService.updatePlanStep(stepId, { notes });
    } catch (err) {
      console.warn('updateStepNotes failed', err);
    }
  }, []);

  const deletePlan = useCallback(async () => {
    if (!latestPlan?.plan?.id) return;
    if (!window.confirm('Discard this plan? You can generate a fresh one anytime.')) return;
    try {
      await campaignAssistantService.deletePlan(latestPlan.plan.id);
      setLatestPlan(null);
    } catch (err) {
      console.warn('deletePlan failed', err);
    }
  }, [latestPlan]);

  // Execute a plan step against the Google Ads API and merge the updated
  // step row back into local state. Returns the executed-result summary so
  // the row's preview panel can display it inline.
  const applyPlanStep = useCallback(async (stepId) => {
    try {
      const res = await campaignAssistantService.applyPlanStep(stepId);
      setLatestPlan(prev => prev && ({
        ...prev,
        steps: prev.steps.map(s => s.id === stepId ? { ...s, ...res.step } : s),
      }));
      return { ok: true, executed: res.executed };
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to apply step';
      // Reflect the failure in the step row for visibility.
      setLatestPlan(prev => prev && ({
        ...prev,
        steps: prev.steps.map(s => s.id === stepId ? { ...s, status: 'failed', applied_error: msg } : s),
      }));
      return { ok: false, error: msg };
    }
  }, []);

  const openConversation = useCallback(async (id) => {
    if (streaming) return;
    setLoadingConversation(true);
    setLatestPlan(null);
    setPlanError(null);
    try {
      const res = await campaignAssistantService.getConversation(id);
      setActiveConversation(res.conversation);
      setSnapshotMeta(res.snapshotMeta);
      setMessages(res.messages || []);
      // Load the latest plan (if any) in parallel; don't block conversation open.
      loadLatestPlan(id);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingConversation(false);
    }
  }, [streaming, loadLatestPlan]);

  const deleteConversation = useCallback(async (id) => {
    if (!window.confirm('Delete this conversation?')) return;
    try {
      await campaignAssistantService.deleteConversation(id);
      setConversations(prev => prev.filter(c => c.id !== id));
      if (activeConversation?.id === id) {
        setActiveConversation(null);
        setMessages([]);
        setSnapshotMeta(null);
        setLatestPlan(null);
      }
    } catch (err) {
      console.error(err);
    }
  }, [activeConversation]);

  const sendMessage = useCallback(async (text, conversationId, attachments = [], targets = ['openai', 'claude']) => {
    const convId = conversationId || activeConversation?.id;
    const hasContent = (text && text.trim()) || (attachments && attachments.length > 0);
    if (!convId || !hasContent) return;
    const wantOpenai = targets.includes('openai');
    const wantClaude = targets.includes('claude');
    setStreaming(true);

    // Local optimistic placeholders — replaced with real DB rows once the
    // 'start' frame arrives. Only insert placeholders for the providers
    // we're actually sending to.
    const tempTurn = Math.max(0, ...messages.map(m => m.turn_index ?? 0)) + (messages.length ? 1 : 0);
    const optimisticUser = { id: `tmp-user-${Date.now()}`, turn_index: tempTurn, role: 'user', content: text, status: 'complete' };
    const optimisticOpenai = wantOpenai
      ? { id: `tmp-openai-${Date.now()}`, turn_index: tempTurn, role: 'assistant', provider: 'openai', content: '', status: 'streaming' }
      : null;
    const optimisticClaude = wantClaude
      ? { id: `tmp-claude-${Date.now()}`, turn_index: tempTurn, role: 'assistant', provider: 'claude', content: '', status: 'streaming' }
      : null;
    const toInsert = [optimisticUser, optimisticOpenai, optimisticClaude].filter(Boolean);
    setMessages(prev => [...prev, ...toInsert]);

    let openaiId = optimisticOpenai?.id || null;
    let claudeId = optimisticClaude?.id || null;
    let userId = optimisticUser.id;

    // Strip the local-only preview URL before sending; server only wants
    // {type, mediaType, data} per attachment.
    const cleanAttachments = (attachments || []).map(a => ({
      type: a.type,
      mediaType: a.mediaType,
      data: a.data,
    }));

    streamCtrlRef.current = campaignAssistantService.streamChat({
      conversationId: convId,
      message: text,
      attachments: cleanAttachments,
      targets,
      onEvent: (evt) => {
        if (evt.type === 'start') {
          // Swap temp ids for real DB ids.
          setMessages(prev => prev.map(m => {
            if (m.id === userId) return { ...m, id: evt.userMessageId };
            if (openaiId && m.id === openaiId && evt.openaiMessageId) return { ...m, id: evt.openaiMessageId, turn_index: evt.turnIndex };
            if (claudeId && m.id === claudeId && evt.claudeMessageId) return { ...m, id: evt.claudeMessageId, turn_index: evt.turnIndex };
            return m;
          }));
          userId = evt.userMessageId;
          if (evt.openaiMessageId) openaiId = evt.openaiMessageId;
          if (evt.claudeMessageId) claudeId = evt.claudeMessageId;
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

  const addAttachmentFiles = useCallback(async (files) => {
    setComposerError(null);
    const room = MAX_ATTACHMENTS_PER_TURN - composerAttachments.length;
    if (room <= 0) {
      setComposerError(`Max ${MAX_ATTACHMENTS_PER_TURN} attachments per message.`);
      return;
    }
    const slice = Array.from(files).slice(0, room);
    const added = [];
    for (const f of slice) {
      try {
        const a = await fileToAttachment(f);
        if (a) added.push(a);
      } catch (err) {
        setComposerError(err.message || 'Could not read file.');
      }
    }
    if (added.length) {
      setComposerAttachments(prev => [...prev, ...added]);
    }
  }, [composerAttachments.length]);

  const handleComposerPaste = useCallback(async (e) => {
    const items = e.clipboardData?.items || [];
    const imageFiles = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && ACCEPTED_IMAGE_TYPES.includes(f.type)) imageFiles.push(f);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      await addAttachmentFiles(imageFiles);
    }
  }, [addAttachmentFiles]);

  const handleFilePick = useCallback(async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await addAttachmentFiles(files);
    e.target.value = ''; // allow selecting the same file again later
  }, [addAttachmentFiles]);

  const removeAttachment = useCallback((id) => {
    setComposerAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const handleSend = useCallback((targets = ['openai', 'claude']) => {
    const text = composer.trim();
    const hasAttachments = composerAttachments.length > 0;
    if (streaming) return;
    if (!text && !hasAttachments) return;
    setComposer('');
    const atts = composerAttachments;
    setComposerAttachments([]);
    setComposerError(null);
    sendMessage(text, undefined, atts, targets);
  }, [composer, composerAttachments, streaming, sendMessage]);

  // "Copy for review" — puts the given assistant response into the main
  // composer wrapped in a review-request prefix. User then picks a target
  // (usually the OTHER provider) via the three send buttons.
  const composerRef = useRef(null);
  const copyForReview = useCallback(({ content, fromProvider }) => {
    const label = fromProvider === 'openai' ? 'OpenAI (gpt-4o)' : 'Claude (Sonnet)';
    const prefix = `Please review the following response from ${label} and give your critique — where do you agree, where would you push back, and what would you add?\n\n---\n`;
    const suffix = '\n---\n\nYour take?';
    setComposer(prefix + content + suffix);
    // Focus + scroll to the composer so the user can immediately act on it.
    setTimeout(() => {
      composerRef.current?.focus();
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 0);
  }, []);

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

  // Report results on a plan step (positive or negative). Backend runs
  // an AI decision that picks close/refactor/postpone/delete and applies
  // it to the step. Returns the AI's reasoning so the UI can show it.
  const reportPlanStepResults = useCallback(async (stepId, results) => {
    try {
      const res = await campaignAssistantService.reportPlanStepResults(stepId, results);
      if (res.deleted) {
        // Remove from local state.
        setLatestPlan(prev => prev && ({
          ...prev,
          steps: prev.steps.filter(s => s.id !== stepId),
        }));
      } else if (res.step) {
        setLatestPlan(prev => prev && ({
          ...prev,
          steps: prev.steps.map(s => s.id === stepId ? { ...s, ...res.step } : s),
        }));
      }
      return { ok: true, decision: res.decision, deleted: res.deleted };
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to report results';
      return { ok: false, error: msg };
    }
  }, []);

  // Push back on a plan step: mark it skipped + persist the feedback as
  // a note, then fire a targeted chat message to Both models asking for
  // reconsideration. Both the note and the chat message flow into future
  // context (via plan-progress block + transcript persistence).
  // (Declared AFTER sendMessage to avoid TDZ crash — this useCallback
  // lists sendMessage in its deps array so sendMessage's const binding
  // must exist by the time this line evaluates.)
  const pushBackPlanStep = useCallback(async (stepId, feedback) => {
    try {
      const res = await campaignAssistantService.pushBackPlanStep(stepId, feedback);
      setLatestPlan(prev => prev && ({
        ...prev,
        steps: prev.steps.map(s => s.id === stepId ? { ...s, ...res.step } : s),
      }));
      if (res.chatPrompt) {
        sendMessage(res.chatPrompt, undefined, [], ['openai', 'claude']);
      }
      return { ok: true };
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to push back';
      return { ok: false, error: msg };
    }
  }, [sendMessage]);

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
            generatedAt={activeConversation.report_generated_at}
          />
        )}

        {activeConversation && (
          <ActionPlanPanel
            plan={latestPlan}
            loading={planLoading}
            error={planError}
            open={planPanelOpen}
            onToggle={() => setPlanPanelOpen(v => !v)}
            onGenerate={generatePlan}
            onToggleStepStatus={toggleStepStatus}
            onUpdateStepNotes={updateStepNotes}
            onDeletePlan={deletePlan}
            onApplyStep={applyPlanStep}
            onReportResults={reportPlanStepResults}
            snapshotGeneratedAt={activeConversation.report_generated_at}
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
              onCopyForReview={copyForReview}
              conversationId={activeConversation.id}
            />
          ))}
        </div>

        <div className="border-t border-gray-200 p-3 bg-white">
          <AttachmentStrip items={composerAttachments} onRemove={removeAttachment} />
          {composerError && (
            <div className="flex items-start gap-1.5 text-xs text-red-700 mb-2">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>{composerError}</span>
            </div>
          )}
          <div className="flex gap-2 items-end">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              multiple
              onChange={handleFilePick}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!activeConversation || streaming || composerAttachments.length >= MAX_ATTACHMENTS_PER_TURN}
              title={composerAttachments.length >= MAX_ATTACHMENTS_PER_TURN
                ? `Max ${MAX_ATTACHMENTS_PER_TURN} images per message`
                : 'Attach image(s) — PNG / JPEG / WebP / GIF, ≤5MB each. You can also paste from the clipboard.'}
              className="p-2 text-gray-500 hover:text-primary-600 hover:bg-gray-50 rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <textarea
              ref={composerRef}
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onPaste={handleComposerPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend(['openai', 'claude']);
                }
              }}
              placeholder={activeConversation
                ? 'Ask a follow-up… paste screenshots or click the clip to attach images.'
                : 'Start a new analysis first (pick a customer + campaign on the left)'}
              disabled={!activeConversation || streaming}
              rows={2}
              className="flex-1 resize-none border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-400"
            />
          </div>
          <div className="flex gap-1.5 mt-2 justify-end">
            <button
              onClick={() => handleSend(['claude'])}
              disabled={!activeConversation || streaming || (!composer.trim() && composerAttachments.length === 0)}
              title="Send only to Claude"
              className="px-3 py-1.5 border border-orange-300 text-orange-700 bg-orange-50 text-xs font-medium rounded-md hover:bg-orange-100 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Send className="h-3 w-3" /> Claude
            </button>
            <button
              onClick={() => handleSend(['openai'])}
              disabled={!activeConversation || streaming || (!composer.trim() && composerAttachments.length === 0)}
              title="Send only to OpenAI"
              className="px-3 py-1.5 border border-green-300 text-green-700 bg-green-50 text-xs font-medium rounded-md hover:bg-green-100 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Send className="h-3 w-3" /> OpenAI
            </button>
            <button
              onClick={() => handleSend(['openai', 'claude'])}
              disabled={!activeConversation || streaming || (!composer.trim() && composerAttachments.length === 0)}
              title="Send to both providers (Enter)"
              className="px-3 py-1.5 bg-primary-600 text-white text-xs font-medium rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Send to Both
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
const SnapshotBanner = ({ snapshotMeta, open, onToggle, generatedAt }) => {
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

  const generatedAtLabel = generatedAt ? new Date(generatedAt).toLocaleString() : null;
  const ageHours = generatedAt ? (Date.now() - new Date(generatedAt).getTime()) / 3_600_000 : null;
  const isStale = ageHours != null && ageHours > 24;

  return (
    <div className="border-b border-gray-200 bg-gray-50">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Report snapshot
        <span className="text-gray-400">·</span>
        <span className="text-gray-500 truncate">
          {fmtMoney(s.cost)} spend · {fmtInt(s.clicks)} clicks · {fmtInt(s.conversions)} conv · {alertCount} alerts
        </span>
        {snapshotMeta.hasFirebase && <span className="ml-2 px-1.5 py-0.5 bg-orange-100 text-orange-800 rounded text-[10px] flex-shrink-0">Firebase</span>}
        {snapshotMeta.hasOpenAiAds && <span className="ml-1 px-1.5 py-0.5 bg-purple-100 text-purple-800 rounded text-[10px] flex-shrink-0">OpenAI Ads</span>}
        {errs.length > 0 && <span className="ml-1 px-1.5 py-0.5 bg-yellow-100 text-yellow-800 rounded text-[10px] flex-shrink-0">{errs.length} partial errors</span>}
        {isStale && <span className="ml-1 px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded text-[10px] flex-shrink-0" title={`Snapshot is ${Math.round(ageHours)}h old — click ⟳ on the Plan panel to refresh + regenerate`}>Stale</span>}
      </button>
      {open && (
        <>
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
          {generatedAtLabel && (
            <div className="px-4 pb-2 text-[10px] text-gray-500">
              Snapshot from {generatedAtLabel}{isStale && ` · ${Math.round(ageHours)}h old`}
            </div>
          )}
        </>
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
// ActionPlanPanel — collapsible checklist rendered above the chat.
// Owns per-step interactions (toggle status, notes) but delegates all
// mutation calls to props (state lives in the parent CampaignAssistant).
// ---------------------------------------------------------------------------

const STEP_TYPE_META = {
  google_ads_action: { label: 'Google Ads', dot: 'bg-blue-500', chip: 'bg-blue-100 text-blue-800' },
  app_code_change:   { label: 'App code',   dot: 'bg-purple-500', chip: 'bg-purple-100 text-purple-800' },
  product_change:    { label: 'Product',    dot: 'bg-pink-500', chip: 'bg-pink-100 text-pink-800' },
  observation:       { label: 'Observe',    dot: 'bg-yellow-500', chip: 'bg-yellow-100 text-yellow-800' },
  schedule:          { label: 'Schedule',   dot: 'bg-teal-500', chip: 'bg-teal-100 text-teal-800' },
  other:             { label: 'Other',      dot: 'bg-gray-400', chip: 'bg-gray-100 text-gray-700' },
};

const PRIORITY_META = {
  high:   { label: 'High',   chip: 'bg-red-50 text-red-700 border-red-200' },
  medium: { label: 'Med',    chip: 'bg-amber-50 text-amber-700 border-amber-200' },
  low:    { label: 'Low',    chip: 'bg-gray-50 text-gray-600 border-gray-200' },
};

const ActionPlanPanel = ({
  plan, loading, error, open, onToggle,
  onGenerate, onToggleStepStatus, onUpdateStepNotes, onDeletePlan, onApplyStep, onReportResults,
  snapshotGeneratedAt,
}) => {
  // Stale if the report snapshot was refreshed AFTER this plan was generated.
  // Suggests the plan's recommendations may reflect out-of-date state.
  const planIsStale = plan?.plan?.created_at && snapshotGeneratedAt
    && new Date(snapshotGeneratedAt).getTime() > new Date(plan.plan.created_at).getTime() + 60_000;
  const hasPlan = !!plan?.plan;
  const steps = plan?.steps || [];
  const doneCount = steps.filter(s => s.status === 'done' || s.status === 'applied').length;
  const autoCount = steps.filter(s => s.type === 'google_ads_action').length;

  return (
    <div className="border-b border-gray-200 bg-emerald-50/40">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs font-medium text-emerald-900 hover:bg-emerald-100/40"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <ClipboardList className="h-3.5 w-3.5" />
        Action plan
        <span className="text-gray-400">·</span>
        {hasPlan ? (
          <span className="text-gray-600 font-normal">
            {doneCount}/{steps.length} done · {autoCount} automatable
          </span>
        ) : (
          <span className="text-gray-600 font-normal">Not generated yet</span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-3">
          {!hasPlan && !loading && (
            <PlanEmptyState onGenerate={onGenerate} error={error} />
          )}
          {loading && <PlanLoadingState />}
          {hasPlan && !loading && (
            <>
              {planIsStale && (
                <div className="mb-2 p-2 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-800 flex items-start gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span>
                    Snapshot has been refreshed since this plan was generated. Some steps may already be resolved
                    or based on stale numbers. Consider clicking regenerate (⟳) for a fresh plan against current data.
                    Applying individual steps still runs a pre-flight check against live state, so no-ops are safe.
                  </span>
                </div>
              )}
              <PlanContent
                plan={plan}
                steps={steps}
                onToggleStepStatus={onToggleStepStatus}
                onUpdateStepNotes={onUpdateStepNotes}
                onDeletePlan={onDeletePlan}
                onRegenerate={onGenerate}
                onApplyStep={onApplyStep}
                onReportResults={onReportResults}
                error={error}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
};

const PlanEmptyState = ({ onGenerate, error }) => (
  <div className="text-center py-4 space-y-2">
    <p className="text-sm text-gray-700">
      Ready to turn the discussion into a concrete plan?
    </p>
    <p className="text-xs text-gray-500 max-w-xl mx-auto">
      The two models have a real 4-round dialogue: OpenAI drafts a plan, Claude critiques it, OpenAI
      revises in response to the critique, Claude finalizes with convergence notes summarizing the
      exchange. Takes ~2-4 minutes. Result is a deduped, dependency-ordered checklist tagged by
      what's automatable via Google Ads API vs. developer / product tasks.
    </p>
    <div className="pt-1">
      <button
        onClick={onGenerate}
        className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 inline-flex items-center gap-2"
      >
        <Sparkles className="h-4 w-4" /> Generate consensus plan
      </button>
    </div>
    {error && (
      <div className="text-xs text-red-700 flex items-center justify-center gap-1.5">
        <AlertCircle className="h-3.5 w-3.5" /> {error}
      </div>
    )}
  </div>
);

// Loading state that walks through the 4 dialogue rounds. Progresses by
// wall-clock time (real progress would require SSE) — timings tuned to
// typical run durations (~40s per round + reconciliation slower).
const PlanLoadingState = () => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // Round boundaries in seconds — cumulative. Adjust if real runs diverge.
  const boundaries = [40, 75, 130, 200];
  const labels = [
    'OpenAI drafts an initial plan',
    'Claude critiques the draft',
    'OpenAI revises in response to the critique',
    'Claude finalises with convergence notes',
  ];
  const currentIdx = boundaries.findIndex(b => elapsed < b);
  const activeIdx = currentIdx === -1 ? labels.length - 1 : currentIdx;
  const phases = labels.map((label, i) => ({
    label,
    done: elapsed >= boundaries[i],
    active: i === activeIdx,
  }));
  return (
    <div className="py-4 space-y-3">
      <div className="text-center">
        <Loader2 className="h-5 w-5 animate-spin text-emerald-600 mx-auto" />
        <p className="text-sm text-gray-700 font-medium mt-2">
          Running a 4-round dialogue between OpenAI and Claude…
        </p>
        <p className="text-[11px] text-gray-500 mt-0.5">
          {elapsed}s · typical run is 2-4 min
        </p>
      </div>
      <ol className="max-w-md mx-auto space-y-1">
        {phases.map((p, i) => (
          <li
            key={i}
            className={`flex items-center gap-2 text-xs ${
              p.done ? 'text-gray-400' : p.active ? 'text-emerald-800 font-medium' : 'text-gray-500'
            }`}
          >
            {p.done
              ? <Check className="h-3.5 w-3.5 text-emerald-500" />
              : p.active
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <Circle className="h-3 w-3" />}
            <span className="text-[10px] font-mono text-gray-400 mr-1">R{i + 1}</span>
            {p.label}
          </li>
        ))}
      </ol>
    </div>
  );
};

const PlanContent = ({ plan, steps, onToggleStepStatus, onUpdateStepNotes, onDeletePlan, onRegenerate, onApplyStep, onReportResults, error }) => {
  const [notesOpen, setNotesOpen] = useState(false);
  const generatedBy = plan.plan.generated_by;
  const isJoint = generatedBy === 'dialogue' || generatedBy === 'consensus';
  const isDegraded = plan.plan.degraded === true;
  const convergenceNotes = plan.plan.convergence_notes;
  const jointChipLabel = generatedBy === 'dialogue'
    ? 'Consensus · OpenAI ↔ Claude (4-round dialogue)'
    : 'Consensus · OpenAI + Claude';

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-semibold text-gray-900">{plan.plan.title}</div>
            {isJoint && !isDegraded && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 uppercase font-semibold tracking-wide">
                {jointChipLabel}
              </span>
            )}
            {isDegraded && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 uppercase font-semibold tracking-wide" title="One or more dialogue rounds failed. Plan reflects the last successful state.">
                Partial dialogue
              </span>
            )}
          </div>
          {plan.plan.summary && (
            <div className="text-xs text-gray-600 mt-0.5">{plan.plan.summary}</div>
          )}
          <div className="text-[10px] text-gray-400 mt-1">
            {plan.plan.model && `Model: ${plan.plan.model} · `}
            {plan.plan.cost_usd != null && `$${Number(plan.plan.cost_usd).toFixed(4)} · `}
            {new Date(plan.plan.created_at).toLocaleString()}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onRegenerate}
            title="Full re-analyze — refreshes the snapshot from live Google Ads + GA4 data, then regenerates the plan against the fresh data + all transcript context. Replaces this plan in the header; old plans stay in DB."
            className="p-1 text-gray-500 hover:text-emerald-700 hover:bg-emerald-100 rounded"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onDeletePlan}
            title="Discard this plan"
            className="p-1 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {convergenceNotes && (
        <div className="rounded border border-emerald-200 bg-white">
          <button
            onClick={() => setNotesOpen(v => !v)}
            className="w-full flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-50"
          >
            {notesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Convergence notes — how the two models agreed
          </button>
          {notesOpen && (
            <div className="px-3 pb-2 text-xs text-gray-700 whitespace-pre-wrap">
              {convergenceNotes}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-700 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> {error}
        </div>
      )}
      {steps.length === 0 ? (
        <div className="text-xs text-gray-500 py-3">Plan has no steps.</div>
      ) : (
        <ol className="space-y-1.5">
          {steps.map((step, i) => (
            <PlanStepRow
              key={step.id}
              step={step}
              index={i}
              onToggleStatus={() => onToggleStepStatus(step.id, step.status)}
              onUpdateNotes={(notes) => onUpdateStepNotes(step.id, notes)}
              onApplyStep={() => onApplyStep(step.id)}
              onReportResults={(results) => onReportResults(step.id, results)}
            />
          ))}
        </ol>
      )}
    </div>
  );
};

// Whitelist of action_types the backend currently knows how to execute.
// Steps with these types get a working "Apply" button; other automatable
// types still show an "Automatable" chip but the Apply button stays
// disabled with a clear "not implemented yet" message.
const APPLYABLE_ACTION_TYPES = new Set([
  'add_negative_keywords',
  'pause_campaign',
  'enable_campaign',
  'set_primary_conversion_action',
  'set_campaign_budget',
  'set_geo_target_type',
  'add_excluded_locations',
  'mark_ga4_conversion_event',
]);

// Per-action-type one-liner shown next to the Apply/Cancel buttons in
// ApplyPreviewPanel. Duplicated from the ActionParamsSummary hint text
// so users see it before they open the preview details.
function reversibilityHint(actionType) {
  switch (actionType) {
    case 'add_negative_keywords':          return 'Reversible in Google Ads UI · Campaigns → Keywords → Negatives';
    case 'pause_campaign':                 return 'Reversible in Google Ads UI · Campaigns → toggle status back to Enabled';
    case 'enable_campaign':                return 'Reversible in Google Ads UI · Campaigns → toggle status back to Paused';
    case 'set_primary_conversion_action':  return 'Reversible in Google Ads UI · Tools → Conversions → uncheck Primary';
    case 'set_campaign_budget':            return 'Reversible in Google Ads UI · Campaigns → Settings → Budget';
    case 'set_geo_target_type':            return 'Reversible in Google Ads UI · Campaigns → Settings → Locations → Location options';
    case 'add_excluded_locations':         return 'Reversible in Google Ads UI · Campaigns → Locations → remove exclusion';
    case 'mark_ga4_conversion_event':      return 'Reversible in GA4 · Admin → Conversions → toggle off';
    default:                               return 'Check Google Ads / GA4 UI for undo';
  }
}

const PlanStepRow = ({ step, index, onToggleStatus, onUpdateNotes, onApplyStep, onReportResults }) => {
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState(step.notes || '');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);   // {ok, executed?, error?}
  const [devTaskOpen, setDevTaskOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [resultsDraft, setResultsDraft] = useState('');
  const [reportingResults, setReportingResults] = useState(false);
  const [resultsResponse, setResultsResponse] = useState(null); // {ok, decision?, deleted?, error?}

  const typeMeta = STEP_TYPE_META[step.type] || STEP_TYPE_META.other;
  const priorityMeta = PRIORITY_META[step.priority] || PRIORITY_META.medium;
  const isDone = step.status === 'done' || step.status === 'applied';
  const isApplied = step.status === 'applied';
  const isFailed = step.status === 'failed';
  const isAutomatable = step.type === 'google_ads_action' && step.action_type;
  const isReadyToApply = isAutomatable && APPLYABLE_ACTION_TYPES.has(step.action_type);
  const isDevTask = step.type === 'app_code_change';

  const handleApply = async () => {
    setApplying(true);
    setApplyResult(null);
    const res = await onApplyStep();
    setApplying(false);
    setApplyResult(res);
    if (res.ok) setPreviewOpen(false);
  };

  const handleSubmitResults = async () => {
    const results = resultsDraft.trim();
    if (!results) return;
    setReportingResults(true);
    setResultsResponse(null);
    const res = await onReportResults(results);
    setReportingResults(false);
    setResultsResponse(res);
    // Keep the panel open on success so the user can read the AI's
    // reasoning; they close manually. Clear the input so the read state
    // is unambiguous.
    if (res.ok) setResultsDraft('');
  };

  return (
    <li className="border border-gray-200 rounded-md bg-white">
      <div className="flex items-start gap-2 p-2">
        <button
          onClick={onToggleStatus}
          className={`flex-shrink-0 mt-0.5 w-4 h-4 border rounded flex items-center justify-center ${
            isDone
              ? 'bg-emerald-600 border-emerald-600 text-white'
              : 'border-gray-300 hover:border-emerald-500 text-transparent hover:text-emerald-500 bg-white'
          }`}
          aria-label={isDone ? 'Mark not done' : 'Mark done'}
        >
          <Check className="h-3 w-3" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className={`text-[11px] font-mono text-gray-400`}>{String(index + 1).padStart(2, ' ')}.</span>
            <span className={`text-sm font-medium ${isDone ? 'line-through text-gray-400' : 'text-gray-900'}`}>
              {step.title}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-semibold tracking-wide ${typeMeta.chip}`}>
              {typeMeta.label}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border uppercase font-semibold tracking-wide ${priorityMeta.chip}`}>
              {priorityMeta.label}
            </span>
            {step.effort && (
              <span className="text-[10px] text-gray-500">· {step.effort}</span>
            )}
            {isAutomatable && !isReadyToApply && (
              <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded" title={`Google Ads mutation "${step.action_type}" recognised in the plan schema but not yet wired to a live API call.`}>
                Automatable (not wired)
              </span>
            )}
            {isReadyToApply && !isApplied && (
              <span className="text-[10px] text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded uppercase font-semibold tracking-wide">
                Ready to apply
              </span>
            )}
            {isApplied && (
              <span className="text-[10px] text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded uppercase font-semibold tracking-wide">
                Applied
              </span>
            )}
            {isFailed && (
              <span className="text-[10px] text-red-700 bg-red-100 px-1.5 py-0.5 rounded uppercase font-semibold tracking-wide">
                Apply failed
              </span>
            )}
          </div>
          {step.description && (
            <div className={`text-xs text-gray-600 mt-1 whitespace-pre-wrap ${isDone ? 'text-gray-400' : ''}`}>
              {step.description}
            </div>
          )}

          {/* Action buttons row */}
          <div className="mt-1.5 flex items-center flex-wrap gap-x-3 gap-y-1">
            <button
              onClick={() => setNotesOpen(v => !v)}
              className="text-[11px] text-gray-500 hover:text-gray-800"
            >
              {notesOpen ? 'Close notes' : (step.notes ? 'Edit notes' : 'Add notes')}
            </button>
            {isReadyToApply && !isApplied && (
              <button
                onClick={() => setPreviewOpen(v => !v)}
                className="text-[11px] font-medium text-blue-700 hover:text-blue-900 inline-flex items-center gap-1"
              >
                <Sparkles className="h-3 w-3" />
                {previewOpen ? 'Cancel' : 'Preview & apply'}
              </button>
            )}
            {isAutomatable && !isReadyToApply && (
              <button
                disabled
                title={`Action type "${step.action_type}" isn't wired to the Google Ads API yet. Only "add_negative_keywords" is live in this release.`}
                className="text-[11px] text-blue-500 opacity-60 cursor-not-allowed"
              >
                Apply (not wired)
              </button>
            )}
            {isDevTask && (
              <button
                onClick={() => setDevTaskOpen(v => !v)}
                className="text-[11px] font-medium text-purple-700 hover:text-purple-900 inline-flex items-center gap-1"
              >
                <Copy className="h-3 w-3" />
                Create dev task
              </button>
            )}
            {onReportResults && (
              <button
                onClick={() => setResultsOpen(v => !v)}
                title="Report what happened when you tried this step (positive or negative). AI reads the report and decides: close (task done), refactor (reshape it), postpone (skip for now), or delete (task was based on wrong assumption)."
                className="text-[11px] font-medium text-teal-700 hover:text-teal-900 inline-flex items-center gap-1"
              >
                📋 Results
              </button>
            )}
          </div>

          {step.notes && !notesOpen && (
            <div className="mt-1 text-[11px] text-gray-500 italic">
              Notes: "{step.notes.slice(0, 200)}{step.notes.length > 200 ? '…' : ''}"
            </div>
          )}
          {notesOpen && (
            <div className="mt-1.5">
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                onBlur={() => onUpdateNotes(notesDraft)}
                rows={2}
                placeholder="Personal notes on this step…"
                className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              />
            </div>
          )}

          {/* Apply-error banner (shown even when preview is closed) */}
          {isFailed && step.applied_error && !previewOpen && (
            <div className="mt-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 flex items-start gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>Last apply failed: {step.applied_error}</span>
            </div>
          )}

          {/* Preview + apply panel */}
          {previewOpen && isReadyToApply && (
            <ApplyPreviewPanel
              step={step}
              applying={applying}
              applyResult={applyResult}
              onCancel={() => { setPreviewOpen(false); setApplyResult(null); }}
              onApply={handleApply}
            />
          )}

          {/* Dev-task modal (inline panel, not a real modal) */}
          {devTaskOpen && isDevTask && (
            <DevTaskPanel step={step} onClose={() => setDevTaskOpen(false)} />
          )}

          {/* Results — user reports outcome, AI decides fate */}
          {resultsOpen && onReportResults && (
            <div className="mt-2 border border-teal-200 bg-teal-50 rounded p-2 text-xs">
              <div className="flex items-center justify-between mb-1.5">
                <div className="font-semibold text-teal-800 flex items-center gap-1">
                  📋 Report results
                </div>
                <button
                  onClick={() => { setResultsOpen(false); setResultsResponse(null); }}
                  className="text-[11px] text-teal-700 hover:text-teal-900"
                >
                  Close
                </button>
              </div>
              <p className="text-[11px] text-teal-800 mb-1.5">
                Paste what happened when you tried this — positive or negative. AI reads the results
                and decides: <b>close</b> (done), <b>refactor</b> (reshape it), <b>postpone</b> (skip
                for now), or <b>delete</b> (was wrong assumption). Applies immediately; the reasoning
                stays as a note.
              </p>
              <textarea
                value={resultsDraft}
                onChange={(e) => setResultsDraft(e.target.value)}
                rows={4}
                disabled={reportingResults}
                placeholder="What happened when you tried this? (paste your coding agent's response, describe the QA outcome, note the metric change, etc.)"
                className="w-full text-xs border border-teal-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-teal-400 disabled:opacity-60"
              />
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={handleSubmitResults}
                  disabled={reportingResults || !resultsDraft.trim()}
                  className="px-2.5 py-1 bg-teal-600 text-white text-[11px] font-medium rounded hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  {reportingResults ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  {reportingResults ? 'AI deciding…' : 'Submit & let AI decide'}
                </button>
                <button
                  onClick={() => { setResultsOpen(false); setResultsResponse(null); }}
                  disabled={reportingResults}
                  className="px-2.5 py-1 border border-gray-300 text-gray-700 text-[11px] font-medium rounded hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
              {resultsResponse && !resultsResponse.ok && (
                <div className="mt-2 text-[11px] text-red-800 flex items-start gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span>{resultsResponse.error || 'Failed to report results.'}</span>
                </div>
              )}
              {resultsResponse?.ok && resultsResponse.decision && (
                <ResultsDecisionBanner decision={resultsResponse.decision} deleted={resultsResponse.deleted} />
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
};

// ---------------------------------------------------------------------------
// ApplyPreviewPanel — inline preview + confirm for a Google Ads mutation.
// Shows the exact params that will be sent, an explicit "Apply now" button,
// and the executed result (or error) after the API call completes.
// ---------------------------------------------------------------------------
const ApplyPreviewPanel = ({ step, applying, applyResult, onCancel, onApply }) => {
  const params = step.action_params || {};
  return (
    <div className="mt-2 border border-blue-200 bg-blue-50 rounded p-2 text-xs">
      <div className="font-semibold text-blue-900 mb-1">
        Preview: {step.action_type}
      </div>
      <ActionParamsSummary actionType={step.action_type} params={params} />
      {applyResult?.ok && applyResult.executed && (
        (() => {
          const isNoop = !!applyResult.executed.noop;
          const bgCls = isNoop ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800';
          const iconCls = isNoop ? 'text-amber-600' : '';
          return (
            <div className={`mt-2 p-2 border rounded ${bgCls}`}>
              <div className={`font-medium flex items-center gap-1 ${iconCls}`}>
                {isNoop ? <AlertCircle className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                {isNoop ? 'Already done' : 'Applied'}
              </div>
              <div className="mt-1">{applyResult.executed.summary}</div>
              {applyResult.executed.result?.skipped?.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer opacity-80">Skipped items ({applyResult.executed.result.skipped.length})</summary>
                  <ul className="pl-4 mt-1 list-disc">
                    {applyResult.executed.result.skipped.map((s, i) => (
                      <li key={i}>{s.keyword}: {s.reason}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })()
      )}
      {applyResult && !applyResult.ok && (
        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-red-800 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>{applyResult.error}</span>
        </div>
      )}
      {!applyResult?.ok && (
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={onApply}
            disabled={applying}
            className="px-2.5 py-1 bg-blue-600 text-white text-[11px] font-medium rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {applying ? 'Applying…' : 'Apply now'}
          </button>
          <button
            onClick={onCancel}
            disabled={applying}
            className="px-2.5 py-1 border border-gray-300 text-gray-700 text-[11px] font-medium rounded hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <span className="text-[10px] text-gray-500">
            {reversibilityHint(step.action_type)}
          </span>
        </div>
      )}
    </div>
  );
};

const ActionParamsSummary = ({ actionType, params }) => {
  if (actionType === 'add_negative_keywords') {
    const kws = Array.isArray(params.keywords) ? params.keywords : [];
    return (
      <div className="text-gray-800">
        <div><span className="text-gray-500">Campaign:</span> {params.campaignId || params.campaign_id || '(missing)'}</div>
        <div><span className="text-gray-500">Match type:</span> {params.matchType || params.match_type || 'BROAD'}</div>
        <div className="mt-1">
          <span className="text-gray-500">Keywords ({kws.length}):</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {kws.length === 0
              ? <span className="italic text-gray-400">(none — the plan didn't include specific keywords; apply will fail)</span>
              : kws.map((k, i) => (
                <span key={i} className="px-1.5 py-0.5 bg-white border border-blue-200 rounded text-blue-900 text-[11px]">
                  {k}
                </span>
              ))
            }
          </div>
        </div>
      </div>
    );
  }
  if (actionType === 'mark_ga4_conversion_event') {
    return (
      <div className="text-gray-800 space-y-0.5">
        <div><span className="text-gray-500">GA4 property:</span> {params.propertyId || params.property_id || '(use conversation default)'}</div>
        <div><span className="text-gray-500">Event to mark as conversion:</span>{' '}
          <span className="px-1.5 py-0.5 bg-white border border-blue-200 rounded text-blue-900 text-[11px]">
            {params.eventName || params.event_name || '(missing)'}
          </span>
        </div>
        <div className="text-[11px] text-gray-500 mt-1 italic">
          Affects forward measurement only — historical data isn't recomputed. Reversible in GA4 UI: Admin → Conversions → toggle off.
        </div>
      </div>
    );
  }
  if (actionType === 'pause_campaign') {
    return (
      <div className="text-gray-800 space-y-0.5">
        <div><span className="text-gray-500">Campaign:</span> {params.campaignId || params.campaign_id || '(missing)'}</div>
        <div className="text-[11px] text-gray-500 mt-1 italic">
          Serving stops immediately. Reversible: Google Ads UI → Campaigns → click campaign → Enable.
        </div>
      </div>
    );
  }
  if (actionType === 'enable_campaign') {
    return (
      <div className="text-gray-800 space-y-0.5">
        <div><span className="text-gray-500">Campaign:</span> {params.campaignId || params.campaign_id || '(missing)'}</div>
        <div className="text-[11px] text-gray-500 mt-1 italic">
          Serving resumes immediately. Make sure any tracking / bidding fixes are done first. Reversible: Google Ads UI → Campaigns → click campaign → Pause.
        </div>
      </div>
    );
  }
  if (actionType === 'set_primary_conversion_action') {
    const rn = params.conversionActionResourceName || params.conversion_action_resource_name || '';
    const actionId = rn.split('/').pop();
    return (
      <div className="text-gray-800 space-y-0.5">
        <div><span className="text-gray-500">Conversion action:</span>{' '}
          <span className="px-1.5 py-0.5 bg-white border border-blue-200 rounded text-blue-900 text-[11px]">
            {actionId || '(missing)'}
          </span>
        </div>
        <div className="text-[11px] text-gray-500 mt-1 italic">
          Sets <code>primary_for_goal = true</code> at ACCOUNT level. Affects every campaign in the account not overriding via campaign_conversion_goal. Reversible: Google Ads UI → Tools → Conversions → this action → Primary → Off.
        </div>
      </div>
    );
  }
  if (actionType === 'set_geo_target_type') {
    const t = String(params.positiveType || params.positive_type || 'PRESENCE').toUpperCase();
    return (
      <div className="text-gray-800 space-y-0.5">
        <div><span className="text-gray-500">Campaign:</span> {params.campaignId || params.campaign_id || '(missing)'}</div>
        <div><span className="text-gray-500">New positive geo-target mode:</span>{' '}
          <span className="px-1.5 py-0.5 bg-white border border-blue-200 rounded text-blue-900 text-[11px]">
            {t}
          </span>
        </div>
        <div className="text-[11px] text-gray-500 mt-1 italic">
          PRESENCE = people physically in target locations only. PRESENCE_OR_INTEREST additionally targets people who show interest (frequently leaks budget outside target country).
        </div>
      </div>
    );
  }
  if (actionType === 'add_excluded_locations') {
    const ids = Array.isArray(params.locationIds) ? params.locationIds
      : Array.isArray(params.location_ids) ? params.location_ids : [];
    return (
      <div className="text-gray-800 space-y-0.5">
        <div><span className="text-gray-500">Campaign:</span> {params.campaignId || params.campaign_id || '(missing)'}</div>
        <div className="mt-1">
          <span className="text-gray-500">Location IDs to exclude ({ids.length}):</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {ids.length === 0
              ? <span className="italic text-gray-400">(none — action_params.locationIds missing; apply will fail)</span>
              : ids.map((id, i) => (
                <span key={i} className="px-1.5 py-0.5 bg-white border border-blue-200 rounded text-blue-900 text-[11px]">
                  {id}
                </span>
              ))
            }
          </div>
        </div>
        <div className="text-[11px] text-gray-500 mt-1 italic">
          Numeric geo_target_constant IDs. Duplicates are rejected but don't fail the batch.
        </div>
      </div>
    );
  }
  if (actionType === 'set_campaign_budget') {
    const usd = params.dailyBudgetUsd ?? params.daily_budget_usd;
    return (
      <div className="text-gray-800 space-y-0.5">
        <div><span className="text-gray-500">Campaign:</span> {params.campaignId || params.campaign_id || '(missing)'}</div>
        <div><span className="text-gray-500">New daily budget:</span>{' '}
          <span className="px-1.5 py-0.5 bg-white border border-blue-200 rounded text-blue-900 text-[11px]">
            ${usd != null ? Number(usd).toFixed(2) : '(missing)'}
          </span>
        </div>
        <div className="text-[11px] text-gray-500 mt-1 italic">
          Refuses to apply if the campaign uses a SHARED budget (would affect other campaigns). Reversible: Google Ads UI → Campaigns → this campaign → Settings → Budget.
        </div>
      </div>
    );
  }
  return <pre className="text-[10px] text-gray-700 whitespace-pre-wrap">{JSON.stringify(params, null, 2)}</pre>;
};

// ---------------------------------------------------------------------------
// ResultsDecisionBanner — shows the AI's verdict after user reports results.
// One of: close · refactor · postpone · delete. Each gets its own color +
// icon + explanation. For refactor, the AI's new title/description are
// already applied to the step (visible in the row above) so we just
// summarize what changed.
// ---------------------------------------------------------------------------
const ResultsDecisionBanner = ({ decision, deleted }) => {
  const { action, reasoning, newTitle, newDescription } = decision || {};
  const styleMap = {
    close:    { bg: 'bg-emerald-50 border-emerald-200 text-emerald-900', icon: '✓', label: 'Closed', hint: 'Step marked as done. It won\'t show up in future recommendations.' },
    refactor: { bg: 'bg-amber-50 border-amber-200 text-amber-900',       icon: '↺', label: 'Refactored', hint: 'Step title + description have been rewritten based on your report. Still pending.' },
    postpone: { bg: 'bg-blue-50 border-blue-200 text-blue-900',           icon: '⏸', label: 'Postponed', hint: 'Step marked as skipped for now. Can be revived by editing status on the checkbox.' },
    delete:   { bg: 'bg-gray-100 border-gray-300 text-gray-800',          icon: '✗', label: 'Deleted', hint: 'Step removed from the plan entirely. Won\'t reappear on regeneration (AI knows the rejection reason).' },
  };
  const s = styleMap[action] || styleMap.close;
  return (
    <div className={`mt-2 border rounded p-2 ${s.bg}`}>
      <div className="font-semibold flex items-center gap-1.5">
        <span className="text-base">{s.icon}</span>
        <span>AI decision: {s.label}</span>
      </div>
      {reasoning && (
        <div className="mt-1 text-[11px] italic opacity-90">"{reasoning}"</div>
      )}
      {action === 'refactor' && (newTitle || newDescription) && (
        <div className="mt-2 pt-2 border-t border-current opacity-90 text-[11px]">
          {newTitle && <div><b>New title:</b> {newTitle}</div>}
          {newDescription && <div className="mt-0.5"><b>New description:</b> {newDescription}</div>}
        </div>
      )}
      {deleted && (
        <div className="mt-1 text-[11px] opacity-80">
          (This step is gone from the checklist. The rejection reason persists in the plan-progress context so the AI won't re-propose it.)
        </div>
      )}
      <div className="mt-2 text-[10px] opacity-70">{s.hint}</div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// DevTaskPanel — formats a step for either an AI coding agent (Claude Code,
// Cursor, etc.) or a human developer. Two copy buttons; user picks the
// format they need. No backend call — the task text is derived from the
// step fields already loaded in the client.
// ---------------------------------------------------------------------------
const DevTaskPanel = ({ step, onClose }) => {
  const [copied, setCopied] = useState(null); // 'agent' | 'human' | null

  const agentTask = `# Task: ${step.title}

## Context
${step.description || '(no additional context)'}

## Priority
${step.priority || 'medium'}

## Estimated effort
${step.effort || 'unspecified'}

## Please do the following
1. Read the context above.
2. Locate the relevant files (paths may be hinted in the context).
3. Implement the change.
4. Verify the code compiles / lints / tests pass for the affected paths.
5. Report back: what you changed, what you decided against, and any files you couldn't find.

Do not make unrelated cleanups — keep the diff scoped to this task.`;

  const humanTask = `## ${step.title}

**Priority:** ${step.priority || 'medium'}  ·  **Effort:** ${step.effort || 'unspecified'}

### What this achieves
${step.description || '(no additional context)'}

### Sub-steps
Break the work into concrete, sequential actions. Fill in the [brackets] as you scope it out.

1. [First concrete action — what file / setting / UI screen to touch]
   Verify: [How you'll know this sub-step is done — a log line, a checkbox in a console, a query result]
2. [Second action]
   Verify: [...]
3. [Third action]
   Verify: [...]
4. [Continue as needed — 4-8 sub-steps is typical for a step this size]
   Verify: [...]

### Acceptance criteria (whole task)
- The change addresses the specific problem in "What this achieves" above.
- No unrelated refactors or side-effects introduced.
- Affected code paths still build; existing tests still pass.
- A fresh QA pass on the intended surface shows the new behaviour.

### Rollback plan
- [How to revert if this ships and metrics regress — usually: revert the commit, or flip the Remote Config flag back, or delete the created resource. Fill in when scoping.]`;

  const copy = async (text, which) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch (_) { /* clipboard unavailable */ }
  };

  return (
    <div className="mt-2 border border-purple-200 bg-purple-50 rounded p-2 text-xs">
      <div className="flex items-center justify-between mb-1.5">
        <div className="font-semibold text-purple-900 flex items-center gap-1">
          <Copy className="h-3 w-3" /> Dev task
        </div>
        <button onClick={onClose} className="text-[11px] text-purple-700 hover:text-purple-900">Close</button>
      </div>
      <p className="text-[11px] text-purple-800 mb-2">
        Pick a format and copy the task. Paste into your AI coding agent (Claude Code, Cursor, etc.) or a
        ticket in whatever tool your team uses.
      </p>
      <div className="flex flex-wrap gap-1.5 mb-2">
        <button
          onClick={() => copy(agentTask, 'agent')}
          className="px-2.5 py-1 bg-purple-600 text-white text-[11px] font-medium rounded hover:bg-purple-700 flex items-center gap-1"
        >
          <Copy className="h-3 w-3" />
          {copied === 'agent' ? 'Copied!' : 'Copy for AI agent'}
        </button>
        <button
          onClick={() => copy(humanTask, 'human')}
          className="px-2.5 py-1 border border-purple-300 text-purple-800 bg-white text-[11px] font-medium rounded hover:bg-purple-100 flex items-center gap-1"
        >
          <Copy className="h-3 w-3" />
          {copied === 'human' ? 'Copied!' : 'Copy for human dev'}
        </button>
      </div>
      <details className="text-[11px] text-purple-900">
        <summary className="cursor-pointer hover:text-purple-700">Preview task text</summary>
        <div className="mt-2 space-y-2">
          <div>
            <div className="font-semibold mb-1">AI-agent format:</div>
            <pre className="bg-white border border-purple-200 rounded p-2 text-[10px] whitespace-pre-wrap max-h-40 overflow-y-auto">{agentTask}</pre>
          </div>
          <div>
            <div className="font-semibold mb-1">Human-dev format:</div>
            <pre className="bg-white border border-purple-200 rounded p-2 text-[10px] whitespace-pre-wrap max-h-40 overflow-y-auto">{humanTask}</pre>
          </div>
        </div>
      </details>
    </div>
  );
};

// ---------------------------------------------------------------------------
// One conversational turn: user prompt + two side-by-side assistant columns
// ---------------------------------------------------------------------------
const TurnBlock = ({ turn, onRate, onCopyForReview, conversationId }) => {
  // Grid layout adapts: 2-col only when both providers are present, 1-col
  // full-width otherwise (avoids a big blank column when a turn was sent
  // to just one provider via the "Send to Claude / OpenAI" buttons).
  const bothPresent = turn.openai && turn.claude;
  const gridCls = bothPresent ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'flex flex-col gap-3';
  return (
    <div className="space-y-3">
      {turn.user && (
        <div className="flex justify-end">
          <div className="max-w-[85%] bg-primary-600 text-white rounded-lg px-4 py-2 text-sm whitespace-pre-wrap">
            {turn.user.content}
          </div>
        </div>
      )}
      <div className={gridCls}>
        {turn.openai && (
          <ProviderColumn title="OpenAI" provider="openai" msg={turn.openai} onRate={onRate} onCopyForReview={onCopyForReview} conversationId={conversationId} accent="text-green-700" bg="bg-green-50" border="border-green-200" />
        )}
        {turn.claude && (
          <ProviderColumn title="Claude" provider="claude" msg={turn.claude} onRate={onRate} onCopyForReview={onCopyForReview} conversationId={conversationId} accent="text-orange-700" bg="bg-orange-50" border="border-orange-200" />
        )}
      </div>
    </div>
  );
};

const ProviderColumn = ({ title, provider, msg, onRate, onCopyForReview, conversationId, accent, bg, border }) => {
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
            {onCopyForReview && (
              <button
                onClick={() => onCopyForReview({ content: msg.content, fromProvider: provider })}
                title={`Copy this response into the composer wrapped in a review-request prompt (so you can send it to the ${provider === 'openai' ? 'Claude' : 'OpenAI'} for critique)`}
                className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-primary-600"
                aria-label="Copy for review"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            )}
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

// One row in the per-card Ask history — user turns as a right-aligned
// blue chip, assistant turns as a left-aligned white card. Purposely
// minimal styling so the panel doesn't compete with the main chat.
const CardHistoryBubble = ({ msg }) => {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-blue-600 text-white rounded-md px-2 py-1 text-xs whitespace-pre-wrap">
          {msg.content}
        </div>
      </div>
    );
  }
  return (
    <div className="bg-white border border-blue-100 rounded-md px-2 py-1.5">
      <DetailsBody text={msg.content} />
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

// Stable client-side key for a specific issue card. Combines provider with
// a slug of the issue title/fix so per-card history bucket is deterministic
// (and OpenAI's card for "Missing Conversion Tracking" is a different bucket
// than Claude's card of the same name).
function computeCardKey({ provider, title, fix }) {
  const base = String(title || fix || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 200);
  if (!base) return null;
  return `${provider}:${base}`;
}

// Generic one-shot state hook used by both the "steps" and "ask about this"
// inline flows in an IssueCard. Handles a single active stream at a time,
// with content accumulation + terminal state. When cardKey is provided the
// server also persists the user+assistant rows and loads prior card history
// so the model sees the running per-card conversation.
function useOneShotStream({ conversationId, provider }) {
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('idle'); // idle | streaming | complete | failed
  const [error, setError] = useState(null);
  const ctrlRef = useRef(null);
  const start = useCallback(({ prompt, attachments, cardKey }) => {
    if (status === 'streaming') return;
    setStatus('streaming');
    setContent('');
    setError(null);
    let acc = '';
    ctrlRef.current = campaignAssistantService.streamOneShot({
      conversationId,
      prompt,
      provider,
      attachments,
      cardKey,
      onEvent: (evt) => {
        if (evt.type === 'delta') {
          acc += evt.text;
          setContent(acc);
        } else if (evt.type === 'complete') {
          setStatus('complete');
        } else if (evt.type === 'error') {
          setStatus('failed');
          setError(evt.error || 'Provider failed');
        } else if (evt.type === 'done') {
          ctrlRef.current = null;
          setStatus(prev => {
            if (prev !== 'streaming') return prev;
            return acc ? 'complete' : 'failed';
          });
          if (!acc) {
            setError(evt.reason === 'connection_closed'
              ? 'Connection dropped before response finished.'
              : 'No response from provider.');
          }
        }
      },
      onError: (err) => {
        ctrlRef.current = null;
        setStatus('failed');
        setError(err.message || 'Request failed');
      },
    });
  }, [conversationId, provider, status]);
  return { content, status, error, start };
}

const IssueCard = ({ title, fix, details, provider, conversationId }) => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [askText, setAskText] = useState('');
  const [askAttachments, setAskAttachments] = useState([]);
  const [askError, setAskError] = useState(null);
  const [cardHistory, setCardHistory] = useState([]); // prior persisted turns for this card
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const askFileInputRef = useRef(null);

  const hasDetails = details && details.trim().length > 0;
  const canAsk = provider && conversationId && (title || fix);
  const cardKey = useMemo(
    () => computeCardKey({ provider, title, fix }),
    [provider, title, fix]
  );

  // Single unified stream — both "Ask about this" and "Get step-by-step"
  // feed into the same conversation panel so the card's history stays a
  // clean chronological chat instead of two disjoint boxes.
  const chat = useOneShotStream({ conversationId, provider });

  // Lazy-load prior card history the first time either Steps or Ask opens.
  // Skip if we've already loaded it, or if the card has no stable key
  // (e.g. missing title/fix — can't scope history reliably).
  const loadHistory = useCallback(async () => {
    if (historyLoaded || !cardKey || !conversationId) return;
    try {
      const msgs = await campaignAssistantService.getCardMessages(conversationId, cardKey);
      // Show user turns + this-provider assistant turns; skip other-provider
      // turns so this card's Ask panel doesn't leak cross-provider history.
      const filtered = (msgs || []).filter(m =>
        m.role === 'user' || m.provider === provider
      );
      setCardHistory(filtered);
      setHistoryLoaded(true);
    } catch (err) {
      console.warn('loadHistory failed', err);
      setHistoryLoaded(true); // don't retry forever
    }
  }, [cardKey, conversationId, historyLoaded, provider]);

  useEffect(() => {
    if (chatOpen) loadHistory();
  }, [chatOpen, loadHistory]);

  // When a one-shot stream completes, append the (user, assistant) pair to
  // local history so the panel reflects it without an extra fetch.
  const rememberTurn = useCallback((userContent, assistantContent) => {
    if (!cardKey) return;
    const nowIso = new Date().toISOString();
    setCardHistory(prev => [
      ...prev,
      { id: `local-user-${Date.now()}`, role: 'user', content: userContent, created_at: nowIso },
      { id: `local-assistant-${Date.now() + 1}`, role: 'assistant', provider, content: assistantContent, created_at: nowIso },
    ]);
  }, [cardKey, provider]);

  const providerLabel = provider === 'openai' ? 'OpenAI' : 'Claude';

  const cardContext = () => {
    const bits = [];
    if (title) bits.push(`ISSUE: ${title}`);
    if (fix) bits.push(`SUGGESTED FIX: ${fix}`);
    if (details) bits.push(`DETAILS: ${details.slice(0, 1500)}`);
    return bits.join('\n');
  };

  // Shared launcher: prepend a synthetic user marker + fire the request into
  // the unified chat stream. Used by both the free-form Ask and the pre-
  // canned Steps request.
  const runInChat = useCallback(({ userMarker, prompt, attachments }) => {
    if (!canAsk || chat.status === 'streaming') return;
    setChatOpen(true);
    setCardHistory(prev => [
      ...prev,
      { id: `local-user-${Date.now()}`, role: 'user', content: userMarker, created_at: new Date().toISOString() },
    ]);
    chat.start({ prompt, attachments, cardKey });
  }, [canAsk, cardKey, chat]);

  const startSteps = useCallback(() => {
    if (!canAsk) return;
    const parts = [];
    if (title) parts.push(`for the issue "${title}"`);
    if (fix) parts.push(`with the fix "${fix}"`);
    const scope = parts.join(' ') || 'the recommendation';
    const prompt = `Give me the exact click-by-click steps to implement ${scope}. Return a numbered list only — no explanation, no rationale, no data citations. If the fix belongs in a different tool (Google Ads, GA4, Firebase, landing page CMS, tag manager), state which tool at the top on its own line and give steps for that tool.`;
    const userMarker = title
      ? `Give me step-by-step instructions for "${title}".`
      : 'Give me step-by-step instructions.';
    runInChat({ userMarker, prompt });
  }, [canAsk, fix, runInChat, title]);

  const submitAsk = useCallback(async () => {
    if (!canAsk) return;
    const text = askText.trim();
    if (!text && askAttachments.length === 0) return;
    setAskError(null);
    // Only inject the pinned card context on the FIRST turn — subsequent
    // asks reuse the persisted history the server loads by cardKey, so we
    // don't need to keep re-pasting the same block into every prompt.
    const isFirstTurnForCard = cardHistory.length === 0;
    const prompt = isFirstTurnForCard
      ? `You are answering a follow-up question scoped to a SPECIFIC issue on this campaign. Focus your entire response on this one issue — do NOT re-list other issues or re-do a full analysis.

--- ISSUE CONTEXT ---
${cardContext()}
--- END ISSUE CONTEXT ---

USER QUESTION: ${text || '(see attached image)'}

Answer plainly — no ## headings, no "Fix:" format. Prose or short bullets are fine. Cite specific numbers from the campaign data when useful.`
      : text || '(see attached image)';
    const clean = askAttachments.map(a => ({
      type: a.type, mediaType: a.mediaType, data: a.data,
    }));
    runInChat({
      userMarker: text || '(image)',
      prompt,
      attachments: clean,
    });
    setAskText('');
    setAskAttachments([]);
  }, [askAttachments, askText, canAsk, cardContext, cardHistory.length, runInChat]);

  // When the current turn completes, append the assistant reply to history.
  const lastAppendedRef = useRef('');
  useEffect(() => {
    if (chat.status === 'complete' && chat.content && chat.content !== lastAppendedRef.current && cardKey) {
      lastAppendedRef.current = chat.content;
      setCardHistory(prev => [
        ...prev,
        { id: `local-chat-assistant-${Date.now()}`, role: 'assistant', provider, content: chat.content, created_at: new Date().toISOString() },
      ]);
    }
  }, [chat.status, chat.content, cardKey, provider]);

  const addAskFiles = useCallback(async (files) => {
    setAskError(null);
    const room = MAX_ATTACHMENTS_PER_TURN - askAttachments.length;
    if (room <= 0) {
      setAskError(`Max ${MAX_ATTACHMENTS_PER_TURN} images.`);
      return;
    }
    const slice = Array.from(files).slice(0, room);
    const added = [];
    for (const f of slice) {
      try {
        const a = await fileToAttachment(f);
        if (a) added.push(a);
      } catch (err) {
        setAskError(err.message || 'Could not read file.');
      }
    }
    if (added.length) setAskAttachments(prev => [...prev, ...added]);
  }, [askAttachments.length]);

  const handleAskPaste = useCallback(async (e) => {
    const items = e.clipboardData?.items || [];
    const imgs = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && ACCEPTED_IMAGE_TYPES.includes(f.type)) imgs.push(f);
      }
    }
    if (imgs.length > 0) {
      e.preventDefault();
      await addAskFiles(imgs);
    }
  }, [addAskFiles]);

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
        {canAsk && (
          <button
            onClick={() => setChatOpen(v => !v)}
            title={`Open the chat panel for this issue`}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] font-medium text-blue-700 hover:bg-blue-50"
          >
            <HelpCircle className="h-3 w-3" />
            {chatOpen ? 'Hide chat' : 'Ask about this'}
          </button>
        )}
        {canAsk && (
          <button
            onClick={startSteps}
            disabled={chat.status === 'streaming'}
            title={`Ask ${providerLabel} for exact click-by-click steps`}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] font-medium text-primary-700 hover:bg-primary-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ListOrdered className="h-3 w-3" />
            Get step-by-step
          </button>
        )}
      </div>

      {detailsOpen && hasDetails && (
        <div className="px-3 pb-3 border-t border-gray-100"><DetailsBody text={details} /></div>
      )}

      {chatOpen && canAsk && (
        <div className="border-t border-blue-100 bg-blue-50 px-3 py-2.5 flex flex-col">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-800 flex items-center gap-1">
              <HelpCircle className="h-3 w-3" /> {providerLabel} · this issue
              {cardHistory.length > 0 && (
                <span className="ml-1 text-blue-600 normal-case font-normal">
                  · {cardHistory.filter(m => m.role === 'user').length} prior turn{cardHistory.filter(m => m.role === 'user').length === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <button
              onClick={() => setChatOpen(false)}
              className="text-[11px] text-blue-700 hover:text-blue-900"
              aria-label="Close chat"
            >
              Close
            </button>
          </div>

          {/* Unified chronological transcript: prior persisted turns +
              current in-flight assistant reply (if streaming). Everything
              sits above the composer so new messages push up as you chat,
              like any modern chat UI. */}
          {(cardHistory.length > 0 || chat.status === 'streaming') && (
            <div className="mb-2 max-h-80 overflow-y-auto space-y-1.5 pr-1">
              {cardHistory.map(m => (
                <CardHistoryBubble key={m.id} msg={m} />
              ))}
              {chat.status === 'streaming' && (
                <div className="bg-white border border-blue-100 rounded-md px-2 py-1.5">
                  {chat.content ? <DetailsBody text={chat.content} /> : <ThinkingIndicator />}
                </div>
              )}
              {chat.status === 'failed' && !chat.content && (
                <div className="text-xs text-red-700 flex items-start gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span>{chat.error || 'Request failed.'}</span>
                </div>
              )}
            </div>
          )}

          <AttachmentStrip items={askAttachments} onRemove={(id) => setAskAttachments(prev => prev.filter(a => a.id !== id))} />
          {askError && (
            <div className="flex items-start gap-1.5 text-[11px] text-red-700 mb-1.5">
              <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" />
              <span>{askError}</span>
            </div>
          )}
          <div className="flex gap-1.5 items-end">
            <input
              ref={askFileInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              multiple
              onChange={async (e) => {
                if (e.target.files?.length) await addAskFiles(e.target.files);
                e.target.value = '';
              }}
              className="hidden"
            />
            <button
              onClick={() => askFileInputRef.current?.click()}
              disabled={chat.status === 'streaming' || askAttachments.length >= MAX_ATTACHMENTS_PER_TURN}
              title="Attach image (or paste)"
              className="p-1.5 text-gray-500 hover:text-blue-700 hover:bg-blue-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ImageIcon className="h-3.5 w-3.5" />
            </button>
            <textarea
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              onPaste={handleAskPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitAsk();
                }
              }}
              disabled={chat.status === 'streaming'}
              rows={2}
              placeholder="Question about this specific issue… (paste screenshots supported)"
              className="flex-1 resize-none border border-blue-200 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-60"
            />
            <button
              onClick={submitAsk}
              disabled={chat.status === 'streaming' || (!askText.trim() && askAttachments.length === 0)}
              className="px-2.5 py-1 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              {chat.status === 'streaming' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Send
            </button>
          </div>
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
