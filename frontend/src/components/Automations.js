import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Zap, Play, Trash2, Edit3, X, Check, AlertCircle, Clock, RefreshCw, Newspaper, MessageSquare, Building2, Facebook, Instagram, PauseCircle, PlayCircle } from 'lucide-react';
import automationsService from '../services/automationsService';
import connectionsService from '../services/connectionsService';
import businessProfileService from '../services/businessProfileService';

const KIND_META = {
  blog: { label: 'Blog article', icon: Newspaper, color: 'bg-purple-100 text-purple-700' },
  social_post: { label: 'Social post', icon: MessageSquare, color: 'bg-blue-100 text-blue-700' },
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const STATUS_STYLES = {
  ok: 'bg-green-100 text-green-700',
  running: 'bg-amber-100 text-amber-700',
  partial: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
  skipped: 'bg-gray-100 text-gray-500',
};

const cadenceLabel = (c) => {
  if (!c?.frequency) return '—';
  const time = c.time_of_day || '09:00';
  if (c.frequency === 'daily') return `Daily at ${time} UTC`;
  if (c.frequency === 'weekly') return `Every ${DAY_NAMES[c.day_of_week ?? 1]} at ${time} UTC`;
  if (c.frequency === 'monthly') return `Day ${c.day_of_month ?? 1} of month at ${time} UTC`;
  return c.frequency;
};

const targetLabel = (t) => {
  if (!t) return '';
  if (t.type === 'blog') return 'Blog domains';
  if (t.type === 'gmb') return t.label || 'GMB location';
  if (t.type === 'facebook') return `FB: ${t.label || t.connectionId?.slice(0, 6)}`;
  if (t.type === 'instagram') return `IG: ${t.label || t.connectionId?.slice(0, 6)}`;
  return t.type;
};

const targetIcon = (type) => {
  if (type === 'gmb') return Building2;
  if (type === 'facebook') return Facebook;
  if (type === 'instagram') return Instagram;
  return Newspaper;
};

const Automations = () => {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingRule, setEditingRule] = useState(null); // null = closed, {} = new, {...} = edit
  const [busyId, setBusyId] = useState(null); // rule.id currently running

  // Pickable targets: GMB locations + FB/IG connections.
  const [gmbLocations, setGmbLocations] = useState([]);
  const [socialConnections, setSocialConnections] = useState([]);

  // Recent runs per-rule (loaded lazily on expand).
  const [expandedId, setExpandedId] = useState(null);
  const [runsById, setRunsById] = useState({});
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [ruleRows, conns] = await Promise.all([
        automationsService.list(),
        connectionsService.list(),
      ]);
      setRules(ruleRows);
      setSocialConnections((conns || []).filter(c => c.provider === 'facebook' || c.provider === 'instagram'));
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }

    // Load GMB accounts (non-blocking — the form still opens without them).
    try {
      const profiles = await businessProfileService.getAccounts();
      const locs = [];
      for (const p of profiles || []) {
        for (const l of p.locations || []) {
          locs.push({
            accountPath: l.fullPath, // 'accounts/X/locations/Y'
            label: l.title || l.locationName || 'Untitled Location',
            accountLabel: p.businessName || p.accountName || 'Google Business',
          });
        }
      }
      setGmbLocations(locs);
    } catch (e) {
      // Non-fatal — user might not have GMB connected
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggleActive = async (rule) => {
    try {
      const updated = await automationsService.update(rule.id, { active: !rule.active });
      setRules(prev => prev.map(r => r.id === rule.id ? updated : r));
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to update');
    }
  };

  const handleTestRun = async (rule) => {
    if (!window.confirm(`Run "${rule.name}" now?${rule.auto_publish ? '\n\nThis rule has auto-publish ON — it will actually post to your accounts.' : '\n\nAuto-publish is OFF — will only create drafts.'}`)) return;
    setBusyId(rule.id);
    setFlash('');
    try {
      const run = await automationsService.testRun(rule.id);
      setFlash(`Test run finished — status: ${run.status}. ${run.publishResults?.length ? `${run.publishResults.filter(r => r.ok).length}/${run.publishResults.length} targets published.` : ''}`);
      // If this rule's runs panel is open, refresh it.
      if (expandedId === rule.id) {
        const runs = await automationsService.listRuns(rule.id);
        setRunsById(prev => ({ ...prev, [rule.id]: runs }));
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Test run failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (rule) => {
    if (!window.confirm(`Delete automation "${rule.name}"? Past runs stay in the audit log.`)) return;
    try {
      await automationsService.remove(rule.id);
      setRules(prev => prev.filter(r => r.id !== rule.id));
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete');
    }
  };

  const handleExpand = async (rule) => {
    const next = expandedId === rule.id ? null : rule.id;
    setExpandedId(next);
    if (next && !runsById[rule.id]) {
      try {
        const runs = await automationsService.listRuns(rule.id);
        setRunsById(prev => ({ ...prev, [rule.id]: runs }));
      } catch (e) {
        // silent — just don't populate
      }
    }
  };

  const handleSaved = (rule) => {
    setEditingRule(null);
    setRules(prev => {
      const idx = prev.findIndex(r => r.id === rule.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = rule;
        return next;
      }
      return [rule, ...prev];
    });
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="h-6 w-6 text-primary-600" />
            <h1 className="text-2xl font-semibold text-gray-900">Automations</h1>
          </div>
          <p className="text-gray-600 mt-1 max-w-2xl">
            Rules that generate & publish content on a schedule. Set the cadence, pick where it goes, and choose whether it publishes automatically or drafts for review.
          </p>
        </div>
        <button
          onClick={() => setEditingRule({})}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700"
        >
          <Plus className="h-4 w-4" />
          New automation
        </button>
      </div>

      {flash && (
        <div className="mb-4 rounded-md bg-green-50 border border-green-200 px-4 py-2 text-sm text-green-800 flex items-center justify-between">
          <span>{flash}</span>
          <button onClick={() => setFlash('')} className="text-green-700 hover:text-green-900"><X className="h-4 w-4" /></button>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-800 flex items-center gap-2">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : rules.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <Zap className="h-8 w-8 text-gray-400 mx-auto mb-2" />
          <p className="text-gray-700 font-medium">No automations yet</p>
          <p className="text-gray-500 text-sm mt-1">Create one to have blog articles or social posts generated & published on a schedule.</p>
          <button
            onClick={() => setEditingRule({})}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700"
          >
            <Plus className="h-4 w-4" /> Create your first automation
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map(rule => (
            <RuleCard
              key={rule.id}
              rule={rule}
              expanded={expandedId === rule.id}
              runs={runsById[rule.id] || []}
              busy={busyId === rule.id}
              onToggle={() => handleToggleActive(rule)}
              onTestRun={() => handleTestRun(rule)}
              onEdit={() => setEditingRule(rule)}
              onDelete={() => handleDelete(rule)}
              onExpand={() => handleExpand(rule)}
            />
          ))}
        </div>
      )}

      {editingRule !== null && (
        <RuleEditor
          initial={editingRule}
          gmbLocations={gmbLocations}
          socialConnections={socialConnections}
          onClose={() => setEditingRule(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
};

const RuleCard = ({ rule, expanded, runs, busy, onToggle, onTestRun, onEdit, onDelete, onExpand }) => {
  const meta = KIND_META[rule.kind] || KIND_META.social_post;
  const KindIcon = meta.icon;
  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="p-4 flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${meta.color}`}>
              <KindIcon className="h-3.5 w-3.5" /> {meta.label}
            </div>
            {!rule.active && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500">
                <PauseCircle className="h-3.5 w-3.5" /> paused
              </span>
            )}
            {rule.auto_publish ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                auto-publish
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                drafts only
              </span>
            )}
            {rule.status === 'running' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> running now
              </span>
            )}
          </div>
          <h3 className="mt-2 text-base font-semibold text-gray-900 truncate">{rule.name}</h3>
          <div className="mt-1 text-sm text-gray-600 flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> {cadenceLabel(rule.cadence)}
            {rule.next_run_at && rule.active && (
              <span className="text-gray-400 ml-2">
                • next {new Date(rule.next_run_at).toLocaleString()}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(rule.targets || []).map((t, i) => {
              const Icon = targetIcon(t.type);
              return (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-100 text-gray-700 text-xs">
                  <Icon className="h-3 w-3" /> {targetLabel(t)}
                </span>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onTestRun}
            disabled={busy}
            title="Run now"
            className="p-2 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          </button>
          <button
            onClick={onToggle}
            title={rule.active ? 'Pause' : 'Resume'}
            className="p-2 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800"
          >
            {rule.active ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
          </button>
          <button onClick={onEdit} title="Edit" className="p-2 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800">
            <Edit3 className="h-4 w-4" />
          </button>
          <button onClick={onDelete} title="Delete" className="p-2 rounded-md text-gray-500 hover:bg-gray-100 hover:text-red-600">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <button
        onClick={onExpand}
        className="w-full border-t border-gray-100 px-4 py-2 text-xs text-gray-500 hover:bg-gray-50 flex items-center justify-between"
      >
        <span>Recent runs {runs.length ? `(${runs.length})` : ''}</span>
        <span>{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 divide-y divide-gray-100">
          {runs.length === 0 ? (
            <div className="p-4 text-sm text-gray-500 text-center">No runs yet — hit ▶ to test.</div>
          ) : runs.map(run => (
            <div key={run.id} className="p-3 text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center px-2 py-0.5 rounded font-medium ${STATUS_STYLES[run.status] || 'bg-gray-100 text-gray-700'}`}>
                  {run.status}
                </span>
                <span className="text-gray-500">{new Date(run.started_at).toLocaleString()}</span>
                <span className="text-gray-400">• {run.trigger}</span>
                {run.topic && <span className="text-gray-600 italic truncate">topic: {run.topic}</span>}
              </div>
              {run.error && <div className="mt-1 text-red-700">Error: {run.error}</div>}
              {Array.isArray(run.publish_results) && run.publish_results.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {run.publish_results.map((pr, i) => (
                    <span key={i} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded ${pr.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                      {pr.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {pr.label || pr.target}
                      {pr.error ? `: ${pr.error.slice(0, 60)}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const emptyRule = () => ({
  name: '',
  kind: 'social_post',
  cadence: { frequency: 'weekly', day_of_week: 1, time_of_day: '09:00' },
  targets: [],
  topic_source: 'ai_pick',
  topics: [],
  image_source: 'none',
  fixed_image_url: '',
  image_prompt_template: '',
  business_context: { businessName: '', businessType: '', city: '', tone: 'warm, engaging, professional', service: '', targetAudience: '' },
  auto_publish: false,
  active: true,
});

const RuleEditor = ({ initial, gmbLocations, socialConnections, onClose, onSaved }) => {
  const isNew = !initial?.id;
  const [form, setForm] = useState(() => ({ ...emptyRule(), ...initial, cadence: { ...emptyRule().cadence, ...(initial?.cadence || {}) }, business_context: { ...emptyRule().business_context, ...(initial?.business_context || {}) } }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [topicText, setTopicText] = useState(() => Array.isArray(initial?.topics) ? initial.topics.join('\n') : '');

  const setField = (k, v) => setForm(prev => ({ ...prev, [k]: v }));
  const setCadence = (k, v) => setForm(prev => ({ ...prev, cadence: { ...prev.cadence, [k]: v } }));
  const setCtx = (k, v) => setForm(prev => ({ ...prev, business_context: { ...prev.business_context, [k]: v } }));

  const toggleTarget = (target) => {
    setForm(prev => {
      const key = JSON.stringify(target);
      const has = (prev.targets || []).some(t => JSON.stringify(t) === key);
      const next = has ? prev.targets.filter(t => JSON.stringify(t) !== key) : [...prev.targets, target];
      return { ...prev, targets: next };
    });
  };

  const selectedKeys = useMemo(
    () => new Set((form.targets || []).map(t => JSON.stringify(t))),
    [form.targets]
  );

  const isTargetSelected = (target) => selectedKeys.has(JSON.stringify(target));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErr('');
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        kind: form.kind,
        cadence: form.cadence,
        targets: form.targets,
        topic_source: form.topic_source,
        topics: form.topic_source === 'topic_list'
          ? topicText.split('\n').map(s => s.trim()).filter(Boolean)
          : [],
        image_source: form.image_source,
        fixed_image_url: form.image_source === 'fixed' ? form.fixed_image_url : null,
        image_prompt_template: form.image_source === 'ai_generate' ? (form.image_prompt_template || null) : null,
        business_context: form.business_context,
        auto_publish: !!form.auto_publish,
        active: !!form.active,
      };
      const saved = isNew
        ? await automationsService.create(payload)
        : await automationsService.update(initial.id, payload);
      onSaved(saved);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">
              {isNew ? 'New automation' : 'Edit automation'}
            </h2>
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="p-6 space-y-5">
            {err && (
              <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
                {err}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={e => setField('name', e.target.value)}
                placeholder="e.g. Weekly cleaning tips post"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select
                  value={form.kind}
                  onChange={e => setField('kind', e.target.value)}
                  disabled={!isNew}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md disabled:bg-gray-50"
                >
                  <option value="social_post">Social post (GMB / FB / IG)</option>
                  <option value="blog">Blog article</option>
                </select>
                {!isNew && <p className="text-xs text-gray-500 mt-1">Type can't change after creation.</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cadence</label>
                <select
                  value={form.cadence.frequency}
                  onChange={e => setCadence('frequency', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {form.cadence.frequency === 'weekly' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Day of week</label>
                  <select
                    value={form.cadence.day_of_week ?? 1}
                    onChange={e => setCadence('day_of_week', Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    {DAY_NAMES.map((d, i) => (
                      <option key={d} value={i}>{d}</option>
                    ))}
                  </select>
                </div>
              )}
              {form.cadence.frequency === 'monthly' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Day of month</label>
                  <input
                    type="number"
                    min={1}
                    max={28}
                    value={form.cadence.day_of_month ?? 1}
                    onChange={e => setCadence('day_of_month', Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                  <p className="text-xs text-gray-500 mt-1">1–28 to avoid short-month edge cases.</p>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Time (UTC)</label>
                <input
                  type="time"
                  value={form.cadence.time_of_day || '09:00'}
                  onChange={e => setCadence('time_of_day', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
            </div>

            {/* TARGETS */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Where to publish</label>
              {form.kind === 'blog' ? (
                <label className="flex items-start gap-2 p-3 border border-gray-200 rounded-md cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={isTargetSelected({ type: 'blog' })}
                    onChange={() => toggleTarget({ type: 'blog' })}
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-900">All verified blog domains</div>
                    <div className="text-xs text-gray-500">Publishes to every S3-connected blog domain on your account. Configure them under Blogs → Domains.</div>
                  </div>
                </label>
              ) : (
                <div className="space-y-1">
                  {gmbLocations.length === 0 && socialConnections.length === 0 && (
                    <div className="text-xs text-gray-500 border border-dashed border-gray-300 rounded p-3">
                      No connected accounts yet. Add GMB or Facebook/Instagram connections first.
                    </div>
                  )}
                  {gmbLocations.map(loc => {
                    const t = { type: 'gmb', accountPath: loc.accountPath, label: loc.label };
                    return (
                      <label key={loc.accountPath} className="flex items-center gap-2 p-2 border border-gray-200 rounded-md cursor-pointer hover:bg-gray-50">
                        <input type="checkbox" checked={isTargetSelected(t)} onChange={() => toggleTarget(t)} />
                        <Building2 className="h-4 w-4 text-gray-500" />
                        <span className="text-sm text-gray-800 flex-1">{loc.label}</span>
                        <span className="text-xs text-gray-400">{loc.accountLabel}</span>
                      </label>
                    );
                  })}
                  {socialConnections.map(c => {
                    const type = c.provider === 'facebook' ? 'facebook' : 'instagram';
                    const t = { type, connectionId: c.id, label: c.display_name };
                    const Icon = type === 'facebook' ? Facebook : Instagram;
                    return (
                      <label key={c.id} className="flex items-center gap-2 p-2 border border-gray-200 rounded-md cursor-pointer hover:bg-gray-50">
                        <input type="checkbox" checked={isTargetSelected(t)} onChange={() => toggleTarget(t)} />
                        <Icon className="h-4 w-4 text-gray-500" />
                        <span className="text-sm text-gray-800 flex-1">{c.display_name}</span>
                        <span className="text-xs text-gray-400">{c.provider}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* TOPIC SELECTION */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Topics</label>
              <div className="flex gap-4 mb-2">
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="radio"
                    name="topic_source"
                    value="ai_pick"
                    checked={form.topic_source === 'ai_pick'}
                    onChange={() => setField('topic_source', 'ai_pick')}
                  />
                  Let AI pick each time
                </label>
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="radio"
                    name="topic_source"
                    value="topic_list"
                    checked={form.topic_source === 'topic_list'}
                    onChange={() => setField('topic_source', 'topic_list')}
                  />
                  Round-robin list
                </label>
              </div>
              {form.topic_source === 'topic_list' && (
                <textarea
                  rows={5}
                  value={topicText}
                  onChange={e => setTopicText(e.target.value)}
                  placeholder="One topic per line. Cycles through in order."
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              )}
            </div>

            {/* IMAGES (social only — blog auto-picks hero via existing pipeline) */}
            {form.kind === 'social_post' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Image</label>
                <div className="flex gap-4 mb-2 flex-wrap">
                  <label className="flex items-center gap-1 text-sm">
                    <input type="radio" name="image_source" value="none" checked={form.image_source === 'none'} onChange={() => setField('image_source', 'none')} />
                    None (text-only)
                  </label>
                  <label className="flex items-center gap-1 text-sm">
                    <input type="radio" name="image_source" value="fixed" checked={form.image_source === 'fixed'} onChange={() => setField('image_source', 'fixed')} />
                    Fixed image URL
                  </label>
                  <label className="flex items-center gap-1 text-sm">
                    <input type="radio" name="image_source" value="ai_generate" checked={form.image_source === 'ai_generate'} onChange={() => setField('image_source', 'ai_generate')} />
                    AI-generated per post
                  </label>
                </div>
                {form.image_source === 'fixed' && (
                  <input
                    type="url"
                    value={form.fixed_image_url || ''}
                    onChange={e => setField('fixed_image_url', e.target.value)}
                    placeholder="https://…"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  />
                )}
                {form.image_source === 'ai_generate' && (
                  <textarea
                    rows={2}
                    value={form.image_prompt_template || ''}
                    onChange={e => setField('image_prompt_template', e.target.value)}
                    placeholder="Optional prompt template — use {caption} for the caption text. Leave blank for a sensible default."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  />
                )}
                <p className="text-xs text-gray-500 mt-1">
                  Instagram requires an image. Rules with image=none skip IG targets.
                </p>
              </div>
            )}

            {/* BUSINESS CONTEXT — passed into every LLM prompt */}
            <details className="border border-gray-200 rounded-md">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                Business context (used in AI prompts)
              </summary>
              <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                <input type="text" placeholder="Business name" value={form.business_context.businessName || ''} onChange={e => setCtx('businessName', e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm" />
                <input type="text" placeholder="Business type" value={form.business_context.businessType || ''} onChange={e => setCtx('businessType', e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm" />
                <input type="text" placeholder="City / area" value={form.business_context.city || ''} onChange={e => setCtx('city', e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm" />
                <input type="text" placeholder="Primary service" value={form.business_context.service || ''} onChange={e => setCtx('service', e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm" />
                <input type="text" placeholder="Tone (e.g. warm, professional)" value={form.business_context.tone || ''} onChange={e => setCtx('tone', e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm" />
                <input type="text" placeholder="Target audience" value={form.business_context.targetAudience || ''} onChange={e => setCtx('targetAudience', e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm" />
              </div>
            </details>

            {/* SAFETY SWITCHES */}
            <div className="space-y-2">
              <label className="flex items-start gap-2 p-3 border border-amber-200 bg-amber-50 rounded-md cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.auto_publish}
                  onChange={e => setField('auto_publish', e.target.checked)}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-sm font-medium text-gray-900">Auto-publish</div>
                  <div className="text-xs text-gray-700">
                    When ON, each run posts directly to the selected accounts.
                    When OFF (recommended for a first-time test), each run only creates a draft in Blogs / Posts for you to review.
                  </div>
                </div>
              </label>
              <label className="flex items-center gap-2 p-3 border border-gray-200 rounded-md cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={e => setField('active', e.target.checked)}
                />
                <span className="text-sm text-gray-900">Active (scheduler runs this rule)</span>
              </label>
            </div>
          </div>

          <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-3 flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {saving && <RefreshCw className="h-4 w-4 animate-spin" />}
              {isNew ? 'Create automation' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Automations;
