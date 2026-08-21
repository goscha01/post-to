// SEO UI for the article editor.
//
// Exports:
//   - SeoBanner          → compact top strip (word count, keyword, pass count, color dot)
//   - SeoChecklistDrawer → right-side drawer with categorised checks + per-check Fix-with-AI
//   - MetadataEditor     → editable panel for keyword / meta description / slug / tags
//   - useDebouncedSeo    → hook that debounces edit-triggered server re-analysis
//
// Design constraints from the spec:
//   * Backend is the canonical SEO analyzer — DO NOT re-implement rules here.
//     The UI reads `blog.seo_metadata` (server-computed) and calls
//     blogsService.analyzeSeo() after debounced edits.
//   * Existing Post-to visual system — Tailwind + lucide-react. No new lib.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2, AlertTriangle, XCircle, MinusCircle,
  ChevronDown, ChevronUp, X, Sparkles, Loader2, Search,
} from 'lucide-react';
import blogsService from '../../services/blogsService';

// ---------------------------------------------------------------------------
// Status → visual mapping. Keep in sync with backend articleSeoRules.
// ---------------------------------------------------------------------------

const STATUS_DOT = {
  green: 'bg-green-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
};
const STATUS_LABEL = {
  green: 'Strong',
  yellow: 'Improvements recommended',
  red: 'Significant issues',
};

const CHECK_ICON = {
  passed: <CheckCircle2 className="h-4 w-4 text-green-600" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-500" />,
  failed: <XCircle className="h-4 w-4 text-red-600" />,
  not_applicable: <MinusCircle className="h-4 w-4 text-gray-300" />,
};

// ---------------------------------------------------------------------------
// useDebouncedSeo — server re-analysis, debounced.
// ---------------------------------------------------------------------------
//
// Any relevant edit (title, keyword, slug, meta, markdown, tags, hero alt)
// increments `seoInputVersion`. On each version bump we wait `delayMs` ms of
// inactivity, then call blogsService.analyzeSeo. The last response wins —
// stale in-flight responses are ignored. Errors are swallowed on purpose;
// the previous analysis stays visible.
//
// Returns { analysis, recalculating, refresh() } — banner + drawer read
// `analysis` (falling back to the row's cached seo_metadata) and toggle a
// tiny "…" indicator using `recalculating`.
export function useDebouncedSeo({ blogId, seoInputVersion, initialAnalysis, delayMs = 700 }) {
  const [analysis, setAnalysis] = useState(initialAnalysis || null);
  const [recalculating, setRecalculating] = useState(false);
  const timerRef = useRef(null);
  const inflightRef = useRef(0);
  const versionRef = useRef(seoInputVersion);

  // Keep analysis in sync when the parent explicitly resets it (e.g. after a
  // Fix-with-AI call returned a fresh analysis).
  useEffect(() => {
    if (initialAnalysis) setAnalysis(initialAnalysis);
  }, [initialAnalysis]);

  const doAnalyze = useCallback(async () => {
    if (!blogId) return;
    const myTicket = ++inflightRef.current;
    setRecalculating(true);
    try {
      const { seo } = await blogsService.analyzeSeo(blogId);
      // Only apply if we're still the latest request in flight.
      if (myTicket === inflightRef.current) setAnalysis(seo);
    } catch {
      // Silent: keep the previous analysis visible.
    } finally {
      if (myTicket === inflightRef.current) setRecalculating(false);
    }
  }, [blogId]);

  useEffect(() => {
    // First render (versionRef === current) — skip; server already computed on GET.
    if (versionRef.current === seoInputVersion) return;
    versionRef.current = seoInputVersion;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doAnalyze, delayMs);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [seoInputVersion, delayMs, doAnalyze]);

  return { analysis, recalculating, refresh: doAnalyze };
}

// ---------------------------------------------------------------------------
// SeoBanner
// ---------------------------------------------------------------------------

export function SeoBanner({ analysis, recalculating, onOpenChecklist }) {
  if (!analysis) {
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-dashed border-gray-300 bg-gray-50 text-xs text-gray-500">
        <span>SEO analysis pending…</span>
      </div>
    );
  }
  const words = analysis.wordCount ?? '—';
  const kw = analysis.keyword || <span className="text-gray-400 italic">no keyword</span>;
  return (
    <button
      type="button"
      onClick={onOpenChecklist}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-xs text-gray-700 transition-colors"
      title={`Click to open the SEO checklist`}
    >
      <span className="font-medium text-gray-900">Words: {words.toLocaleString ? words.toLocaleString() : words}</span>
      <span className="text-gray-300">|</span>
      <span className="flex items-center gap-1 min-w-0">
        <Search className="h-3.5 w-3.5 text-gray-400 shrink-0" />
        <span className="truncate">Search term: <span className="font-medium">{kw}</span></span>
      </span>
      <span className="text-gray-300">|</span>
      <span className="flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[analysis.status] || 'bg-gray-300'}`} />
        <span className="font-medium text-gray-900">
          {analysis.passed} of {analysis.passed + analysis.warnings + analysis.failed} SEO checks passed
        </span>
        {analysis.warnings > 0 && (
          <span className="text-amber-600">· {analysis.warnings} warning{analysis.warnings === 1 ? '' : 's'}</span>
        )}
        {analysis.failed > 0 && (
          <span className="text-red-600">· {analysis.failed} failed</span>
        )}
      </span>
      <span className="ml-auto flex items-center gap-2 text-gray-500">
        {recalculating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        <span className="text-primary-600 font-medium">View details →</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SeoChecklistDrawer
// ---------------------------------------------------------------------------

const CATEGORY_ORDER = ['meta', 'links', 'media', 'content', 'keyword'];

function groupChecks(checks = []) {
  const groups = {};
  for (const c of checks) {
    if (!groups[c.category]) {
      groups[c.category] = {
        id: c.category,
        label: c.categoryLabel || c.category,
        passed: 0, warnings: 0, failed: 0, notApplicable: 0,
        checks: [],
      };
    }
    const g = groups[c.category];
    g.checks.push(c);
    if (c.status === 'passed') g.passed++;
    else if (c.status === 'warning') g.warnings++;
    else if (c.status === 'failed') g.failed++;
    else g.notApplicable++;
  }
  return CATEGORY_ORDER.filter((id) => groups[id]).map((id) => groups[id]);
}

export function SeoChecklistDrawer({ open, onClose, analysis, blogId, onFixed }) {
  const [expanded, setExpanded] = useState(() => new Set(['meta', 'keyword']));
  const [fixing, setFixing] = useState(null); // checkId currently being fixed
  const [fixingAll, setFixingAll] = useState(false);
  const [fixError, setFixError] = useState('');
  const groups = useMemo(() => groupChecks(analysis?.checks), [analysis]);

  // Count actionable checks so we can enable / label the "Fix all" button.
  const fixableCount = useMemo(() => {
    if (!analysis) return 0;
    const excluded = new Set([
      'hero_image_present', 'hero_alt_present', 'hero_alt_quality',
      'image_alt_coverage', 'keyword_in_image_alt',
      'tags_configured', 'slug_seo_friendly', 'slug_present',
    ]);
    return analysis.checks.filter(
      (c) => (c.status === 'failed' || c.status === 'warning') && !excluded.has(c.id),
    ).length;
  }, [analysis]);

  useEffect(() => {
    if (!open) {
      setFixing(null);
      setFixError('');
    }
  }, [open]);

  const toggleGroup = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const doFix = async (checkId) => {
    if (!blogId) return;
    setFixing(checkId);
    setFixError('');
    try {
      const result = await blogsService.fixSeo(blogId, checkId);
      if (onFixed) onFixed(result);
    } catch (e) {
      setFixError(e.response?.data?.message || e.message || 'Failed to apply fix');
    } finally {
      setFixing(null);
    }
  };

  const doFixAll = async () => {
    if (!blogId || fixingAll) return;
    setFixingAll(true);
    setFixError('');
    try {
      const result = await blogsService.fixSeoAll(blogId);
      if (onFixed) onFixed(result);
    } catch (e) {
      setFixError(e.response?.data?.message || e.message || 'Failed to run Fix all');
    } finally {
      setFixingAll(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose}>
      <div
        className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white">
          <div>
            <h3 className="text-base font-semibold text-gray-900">SEO checklist</h3>
            {analysis && (
              <p className="text-xs text-gray-500 mt-0.5">
                <span className={`inline-block h-2 w-2 rounded-full mr-1 ${STATUS_DOT[analysis.status] || 'bg-gray-300'}`} />
                Score {analysis.score} · {STATUS_LABEL[analysis.status] || ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {fixableCount > 0 && (
              <button
                type="button"
                onClick={doFixAll}
                disabled={fixingAll || !!fixing}
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
                title="Runs Fix with AI on every fixable warning / failure in one pass"
              >
                {fixingAll ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" />Fixing…</>
                ) : (
                  <><Sparkles className="h-3.5 w-3.5" />Fix all ({fixableCount})</>
                )}
              </button>
            )}
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        {fixError && (
          <div className="mx-4 mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{fixError}</div>
        )}
        {!analysis ? (
          <div className="p-4 text-sm text-gray-500">No analysis yet.</div>
        ) : (
          <div className="p-2">
            {groups.map((g) => (
              <div key={g.id} className="border border-gray-200 rounded-lg mb-2">
                <button
                  type="button"
                  onClick={() => toggleGroup(g.id)}
                  className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50"
                >
                  <span className="text-sm font-medium text-gray-900">{g.label}</span>
                  <span className="flex items-center gap-2 text-xs text-gray-500">
                    <span className="text-green-700">{g.passed}✓</span>
                    {g.warnings > 0 && <span className="text-amber-600">{g.warnings}⚠</span>}
                    {g.failed > 0 && <span className="text-red-600">{g.failed}✗</span>}
                    {expanded.has(g.id) ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </span>
                </button>
                {expanded.has(g.id) && (
                  <ul className="border-t border-gray-100 divide-y divide-gray-100">
                    {g.checks.map((c) => (
                      <li key={c.id} className="px-3 py-2 flex items-start gap-2">
                        <span className="mt-0.5 shrink-0">{CHECK_ICON[c.status] || CHECK_ICON.not_applicable}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm text-gray-900">{c.label}</span>
                            {c.value && <span className="text-xs text-gray-500">— {c.value}</span>}
                          </div>
                          {c.recommendation && (
                            <p className="text-xs text-gray-500 mt-0.5">{c.recommendation}</p>
                          )}
                        </div>
                        {(c.status === 'failed' || c.status === 'warning') && (
                          <button
                            type="button"
                            onClick={() => doFix(c.id)}
                            disabled={!!fixing || fixingAll}
                            className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                            title="Ask the AI to fix this specific check"
                          >
                            {fixing === c.id ? (
                              <><Loader2 className="h-3 w-3 animate-spin" />Fixing…</>
                            ) : (
                              <><Sparkles className="h-3 w-3" />Fix with AI</>
                            )}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <p className="mt-3 px-2 text-[11px] text-gray-400">
              Analyzer v{analysis.analyzerVersion} · analyzed {new Date(analysis.analyzedAt).toLocaleString()}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MetadataEditor — SEO-specific fields (kept out of the main markdown flow)
// ---------------------------------------------------------------------------

// Live character-count helper for meta description. Colour matches thresholds
// from backend articleSeoRules — display-only, not authoritative.
function metaLengthTone(len) {
  if (!len) return { color: 'text-gray-400', label: '0 chars' };
  if (len >= 140 && len <= 160) return { color: 'text-green-600', label: `${len} chars — optimal` };
  if (len < 120 || len > 180) return { color: 'text-red-600', label: `${len} chars — outside ideal 140-160` };
  return { color: 'text-amber-600', label: `${len} chars — recommended 140-160` };
}

function titleLengthTone(len) {
  if (!len) return { color: 'text-gray-400', label: '0 chars' };
  if (len >= 45 && len <= 65) return { color: 'text-green-600', label: `${len} chars — optimal` };
  if (len < 30 || len > 75) return { color: 'text-red-600', label: `${len} chars — outside ideal 45-65` };
  return { color: 'text-amber-600', label: `${len} chars — recommended 45-65` };
}

export function MetadataEditor({ blog, onChange }) {
  const setField = (field, value) => onChange({ ...blog, [field]: value });
  const setTags = (tags) => onChange({ ...blog, tags });

  const [tagsInput, setTagsInput] = useState('');
  const tags = Array.isArray(blog?.tags) ? blog.tags : [];

  const addTagFromInput = () => {
    const raw = tagsInput.trim().toLowerCase();
    if (!raw) return;
    if (tags.includes(raw)) { setTagsInput(''); return; }
    setTags([...tags, raw]);
    setTagsInput('');
  };

  const removeTag = (t) => setTags(tags.filter((x) => x !== t));

  const titleTone = titleLengthTone((blog?.title || '').length);
  const metaTone = metaLengthTone((blog?.meta_description || '').length);

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">Article metadata</h3>
        <p className="text-xs text-gray-500 mt-0.5">These fields power SEO, social sharing, and internal indexing.</p>
      </div>
      <div className="p-4 space-y-4">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-gray-600">Search term</label>
            <span className="text-[11px] text-gray-400">Primary target keyword for this article</span>
          </div>
          <input
            type="text"
            value={blog?.keyword || ''}
            onChange={(e) => setField('keyword', e.target.value)}
            placeholder="e.g. house cleaning tampa"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-gray-600">Meta description</label>
            <span className={`text-[11px] ${metaTone.color}`}>{metaTone.label}</span>
          </div>
          <textarea
            value={blog?.meta_description || ''}
            onChange={(e) => setField('meta_description', e.target.value)}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Slug</label>
            <input
              type="text"
              value={blog?.slug || ''}
              onChange={(e) => setField('slug', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-gray-600">Title</label>
              <span className={`text-[11px] ${titleTone.color}`}>{titleTone.label}</span>
            </div>
            <input
              type="text"
              value={blog?.title || ''}
              onChange={(e) => setField('title', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-gray-600">Tags</label>
            <span className="text-[11px] text-gray-400">3–8 short descriptive tags</span>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                  {t}
                  <button
                    type="button"
                    onClick={() => removeTag(t)}
                    className="text-gray-400 hover:text-gray-700"
                    aria-label={`Remove ${t}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTagFromInput(); } }}
              placeholder="type and press Enter"
              className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-xs"
            />
            <button
              type="button"
              onClick={addTagFromInput}
              className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Add
            </button>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-gray-600">Hero image alt text</label>
            <span className="text-[11px] text-gray-400">Describe what's actually in the image</span>
          </div>
          <input
            type="text"
            value={blog?.hero_alt || ''}
            onChange={(e) => setField('hero_alt', e.target.value)}
            placeholder="e.g. A tidy Tampa living room after a routine cleaning visit"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
      </div>
    </div>
  );
}
