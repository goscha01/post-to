import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Calendar as CalendarIcon,
  Clock,
  X,
  Image as ImageIcon,
  ExternalLink,
  Trash2,
  Plus,
  HardDrive,
  Search,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Folder,
  ChevronRight as ChevronRightIcon,
  Home as HomeIcon,
} from 'lucide-react';
import axios from '../utils/axiosConfig';
import { useAuth } from '../contexts/AuthContext';
import businessProfileService from '../services/businessProfileService';
import calendarService from '../services/calendarService';
import postsService from '../services/postsService';
import {
  getRecentUrls,
  rememberUrl,
  getRecentPhones,
  rememberPhone,
} from '../utils/composerMemory';
import {
  CTA_OPTIONS,
  POST_TYPES,
  isCallCta,
  digitsOnly, // eslint-disable-line no-unused-vars
  looksLikePhone,
  toTelUrl,
  SmartPreviewImage,
  DrivePickerModal,
} from './composerShared';

// ── Date helpers ────────────────────────────────────────────

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const startOfWeek = (d) => {
  const x = startOfDay(d);
  x.setDate(x.getDate() - x.getDay()); // Sunday
  return x;
};

const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

const addMonths = (d, n) => {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
};

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const monthGridStart = (anchor) => {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  return startOfWeek(monthStart);
};

const monthGridDays = (anchor) => {
  const gridStart = monthGridStart(anchor);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
};

const weekGridDays = (anchor) => {
  const gridStart = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(gridStart, i));
};

const fmtTime = (d) =>
  d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const fmtMonthYear = (d) =>
  d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

const fmtWeekLabel = (start, end) => {
  const sameMo = start.getMonth() === end.getMonth();
  if (sameMo) {
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${end.getFullYear()}`;
};

const truncate = (s, n = 60) => {
  if (!s) return '';
  return s.length > n ? s.slice(0, n).trim() + '…' : s;
};

// ── Account flattening ─────────────────────────────────────

// GMB returns `address` as a PostalAddress object ({ addressLines, locality, ... }).
// Rendering that object as a React child crashes with error #31.
const formatLocationAddress = (loc) => {
  const short = loc?.storefrontAddress?.locality;
  if (short) return short;
  const addr = loc?.address;
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  const parts = [];
  if (Array.isArray(addr.addressLines)) parts.push(...addr.addressLines);
  if (addr.locality) parts.push(addr.locality);
  if (addr.administrativeArea) parts.push(addr.administrativeArea);
  if (addr.postalCode) parts.push(addr.postalCode);
  return parts.join(', ');
};

// businessProfileService.getAccounts() returns [{ ...account, locations: [{...loc, accountId, fullPath}] }]
// We flatten to a per-location list — one row per business "profile" the
// user thinks about (each GMB location). Tolerant of missing fields — the
// backend normalizer sometimes hands us locations with only `locationName`
// or only `fullPath`, and we should not silently drop them.
const flattenLocations = (profiles) => {
  if (!Array.isArray(profiles)) return [];
  const out = [];
  profiles.forEach((account, ai) => {
    const accountId =
      account?.accountId ||
      account?.name?.replace(/^accounts\//, '').split('/')[0] ||
      null;
    const accountLabel = account?.accountName || account?.displayName || `Account ${ai + 1}`;
    (account?.locations || []).forEach((loc, li) => {
      const locationId =
        loc?.locationId ||
        loc?.name?.split('/').pop() ||
        loc?.fullPath?.split('/').pop() ||
        null;
      if (!accountId || !locationId) return;
      out.push({
        key: `${accountId}:${locationId}`,
        accountId,
        locationId,
        title: loc?.title || loc?.locationName || `Location ${li + 1}`,
        accountLabel,
        addressLine: formatLocationAddress(loc),
      });
    });
  });
  return out;
};

// Assign a deterministic color per location, so pills for the same
// business share the same accent across cells.
const LOCATION_COLORS = [
  { bg: 'bg-emerald-50', border: 'border-emerald-300', dot: 'bg-emerald-500', text: 'text-emerald-900' },
  { bg: 'bg-sky-50', border: 'border-sky-300', dot: 'bg-sky-500', text: 'text-sky-900' },
  { bg: 'bg-violet-50', border: 'border-violet-300', dot: 'bg-violet-500', text: 'text-violet-900' },
  { bg: 'bg-amber-50', border: 'border-amber-300', dot: 'bg-amber-500', text: 'text-amber-900' },
  { bg: 'bg-rose-50', border: 'border-rose-300', dot: 'bg-rose-500', text: 'text-rose-900' },
  { bg: 'bg-teal-50', border: 'border-teal-300', dot: 'bg-teal-500', text: 'text-teal-900' },
];

const colorForLocation = (locationId, allLocations) => {
  if (!locationId) return LOCATION_COLORS[0];
  const idx = allLocations.findIndex((l) => l.locationId === locationId);
  return LOCATION_COLORS[(idx >= 0 ? idx : 0) % LOCATION_COLORS.length];
};

// ── Main component ─────────────────────────────────────────

const Calendar = () => {
  const { isAuthenticated, isDisconnected } = useAuth();
  const navigate = useNavigate();

  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [view, setView] = useState('month'); // 'month' | 'week'
  const [profiles, setProfiles] = useState([]); // raw response from businessProfileService — matches Posts.js iteration
  const [locations, setLocations] = useState([]);
  const [selectedLocationKeys, setSelectedLocationKeys] = useState(() => new Set());
  const [items, setItems] = useState({ published: [], scheduled: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [showKind, setShowKind] = useState('both'); // 'both' | 'scheduled' | 'published'
  const [detailItem, setDetailItem] = useState(null);
  const [scheduleModal, setScheduleModal] = useState(null); // { defaultDate, draft? }
  const [drafts, setDrafts] = useState([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Track which locations we've already synced this session so an auto-run
  // doesn't re-hit GMB every time locations refresh. Ref (not state) because
  // it participates only in guard logic, not render.
  const syncedLocationsRef = useRef(new Set());
  const autoSyncFiredRef = useRef(false);

  // Load accounts + locations
  const loadAccounts = useCallback(
    async (forceRefresh = false) => {
      try {
        const p = await businessProfileService.getAccounts(forceRefresh);
        setProfiles(Array.isArray(p) ? p : []);
        const flat = flattenLocations(p);
        setLocations(flat);
        setSelectedLocationKeys((prev) => {
          if (prev.size > 0) return prev; // keep user selection across reloads
          return new Set(flat.map((l) => l.key));
        });
      } catch (e) {
        // Non-fatal — calendar still works without location filter
      }
    },
    []
  );

  useEffect(() => {
    if (!isAuthenticated || isDisconnected) return;
    // Force-refresh on mount so a stale frontend cache from an earlier page
    // (Posts, Reviews, etc.) doesn't hide accounts the user just connected.
    loadAccounts(true);
  }, [isAuthenticated, isDisconnected, loadAccounts]);

  // Fetch calendar range whenever the anchor/view changes. We over-fetch
  // by ~1 month on each side so paging between adjacent months doesn't
  // trigger a new request unless the user goes several months out.
  const fetchRange = useCallback(
    async (opts = {}) => {
      if (!isAuthenticated || isDisconnected) return;
      const { silent = false } = opts;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const from = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
        const to = new Date(anchor.getFullYear(), anchor.getMonth() + 2, 0, 23, 59, 59, 999);
        const data = await calendarService.getRange({ from, to });
        setItems({
          published: Array.isArray(data.published) ? data.published : [],
          scheduled: Array.isArray(data.scheduled) ? data.scheduled : [],
        });
      } catch (e) {
        setError(e?.response?.data?.error || e?.message || 'Failed to load calendar');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [anchor, isAuthenticated, isDisconnected]
  );

  useEffect(() => {
    fetchRange();
  }, [fetchRange]);

  // Pull recent published posts from GMB for every connected location and
  // cache them into social_media_posts. The calendar reads only from that
  // table, so without this step a fresh user (or a user who's never opened
  // the Posts page) sees an empty "Published" bucket even though their
  // profiles have posts.
  //
  // Bounded concurrency so 20+ locations don't fan out into a burst of
  // parallel GMB requests. Guarded by syncedLocationsRef so repeat calls
  // (auto + manual) don't re-fetch the same location.
  const syncPublishedFromGmb = useCallback(
    async (opts = {}) => {
      const { force = false } = opts;
      if (syncing) return;
      const targets = locations.filter(
        (l) => l.accountId && l.locationId && (force || !syncedLocationsRef.current.has(l.key))
      );
      if (targets.length === 0) return;
      setSyncing(true);
      try {
        const CONCURRENCY = 3;
        let i = 0;
        const worker = async () => {
          while (i < targets.length) {
            const idx = i++;
            const t = targets[idx];
            try {
              await postsService.getPostsForLocation(t.locationId, t.accountId, true);
            } catch {
              // Per-location failure is fine — other locations still sync.
            }
            syncedLocationsRef.current.add(t.key);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker)
        );
        // Re-read the calendar range now that the cache is populated.
        await fetchRange({ silent: true });
      } finally {
        setSyncing(false);
      }
    },
    [locations, syncing, fetchRange]
  );

  // Auto-sync once per session, after locations load, only if the current
  // range has zero published items. Avoids surprising the user with a slow
  // sync when the calendar already has data cached from prior visits.
  useEffect(() => {
    if (autoSyncFiredRef.current) return;
    if (loading) return; // wait for initial calendar fetch to settle
    if (locations.length === 0) return;
    if (items.published.length > 0) return;
    autoSyncFiredRef.current = true;
    syncPublishedFromGmb();
  }, [loading, locations, items.published.length, syncPublishedFromGmb]);

  // Group filtered items by yyyy-mm-dd for the grid
  const itemsByDay = useMemo(() => {
    const map = new Map();
    const kinds = [];
    if (showKind === 'both' || showKind === 'published') kinds.push(...items.published);
    if (showKind === 'both' || showKind === 'scheduled') kinds.push(...items.scheduled);
    for (const it of kinds) {
      if (!it?.when) continue;
      const d = new Date(it.when);
      if (Number.isNaN(d.getTime())) continue;
      // Location filter: an item with no locationId is always shown
      // (defensive — some legacy rows may have missing IDs).
      if (it.locationId && selectedLocationKeys.size > 0) {
        const key = `${it.accountId || ''}:${it.locationId}`;
        if (!selectedLocationKeys.has(key)) continue;
      }
      const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const arr = map.get(dayKey) || [];
      arr.push({ ...it, _date: d });
      map.set(dayKey, arr);
    }
    // Sort each day's items by time
    for (const arr of map.values()) {
      arr.sort((a, b) => a._date - b._date);
    }
    return map;
  }, [items, selectedLocationKeys, showKind]);

  const days = view === 'month' ? monthGridDays(anchor) : weekGridDays(anchor);
  const monthLabel = fmtMonthYear(anchor);
  const weekLabel = useMemo(() => {
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    return fmtWeekLabel(start, end);
  }, [anchor]);

  const goPrev = () => setAnchor((a) => (view === 'month' ? addMonths(a, -1) : addDays(a, -7)));
  const goNext = () => setAnchor((a) => (view === 'month' ? addMonths(a, 1) : addDays(a, 7)));
  const goToday = () => setAnchor(startOfDay(new Date()));

  const toggleLocation = (key) => {
    setSelectedLocationKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllLocations = () => setSelectedLocationKeys(new Set(locations.map((l) => l.key)));
  const clearAllLocations = () => setSelectedLocationKeys(new Set());

  // Empty cell click → open the composer with the clicked date as default.
  // No pre-flight bounce to /connections: the modal has its own empty state
  // (amber hint + Reload button) so a slow loadAccounts or a missing-name
  // location can't hijack the click. If there really are zero connected
  // profiles the user can hit the hint's link in-modal.
  const openCreateForDate = (day) => {
    const now = new Date();
    const isFutureDay = new Date(day).setHours(23, 59, 59, 999) >= now.getTime();
    const seed = new Date(day);
    if (isFutureDay) {
      seed.setHours(9, 0, 0, 0);
      if (seed.getTime() < Date.now()) {
        seed.setTime(Date.now() + 60 * 60 * 1000);
      }
    } else {
      seed.setTime(Date.now() + 60 * 60 * 1000);
    }
    setScheduleModal({ defaultDate: seed });
  };

  const handleScheduled = (opts = {}) => {
    if (!opts.keepOpen) setScheduleModal(null);
    fetchRange({ silent: true });
    loadDrafts();
  };

  const handleCancelled = () => {
    setDetailItem(null);
    fetchRange({ silent: true });
  };

  const loadDrafts = useCallback(async () => {
    if (!isAuthenticated || isDisconnected) return;
    setDraftsLoading(true);
    try {
      const data = await calendarService.listDrafts();
      setDrafts(Array.isArray(data.drafts) ? data.drafts : []);
    } catch {
      // Non-fatal — the calendar still works without drafts
    } finally {
      setDraftsLoading(false);
    }
  }, [isAuthenticated, isDisconnected]);

  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  const openDraft = (draft) => {
    setScheduleModal({
      defaultDate: new Date(Date.now() + 60 * 60 * 1000),
      draft,
    });
  };

  const deleteDraft = async (id) => {
    // eslint-disable-next-line no-restricted-globals, no-alert
    if (!window.confirm('Delete this draft?')) return;
    try {
      await calendarService.deleteDraft(id);
      setDrafts((prev) => prev.filter((d) => d.id !== id));
    } catch {
      // Non-fatal
    }
  };

  const today = startOfDay(new Date());

  return (
    <div className="min-h-[calc(100vh-6rem)]">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <CalendarIcon className="h-6 w-6 text-primary-600" />
            Calendar
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Published posts and upcoming scheduled posts across your business profiles.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => syncPublishedFromGmb({ force: true })}
            disabled={syncing || locations.length === 0}
            title="Pull the latest published posts from Google Business Profile for every connected location"
            className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync from Google'}
          </button>
          <button
            onClick={() => fetchRange({ silent: true })}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => openCreateForDate(new Date())}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-white bg-primary-600 hover:bg-primary-700"
          >
            <Plus className="h-4 w-4" />
            Schedule post
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        {/* Sidebar */}
        <aside className="space-y-6">
          <FilterCard title="Show">
            <div className="flex gap-2 flex-wrap">
              {[
                { k: 'both', label: 'All' },
                { k: 'scheduled', label: 'Scheduled' },
                { k: 'published', label: 'Published' },
              ].map((opt) => (
                <button
                  key={opt.k}
                  onClick={() => setShowKind(opt.k)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    showKind === opt.k
                      ? 'bg-primary-600 text-white border-primary-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </FilterCard>

          <FilterCard
            title="Accounts"
            headerRight={
              locations.length > 0 && (
                <div className="flex gap-2 text-xs">
                  <button onClick={selectAllLocations} className="text-primary-600 hover:underline">
                    All
                  </button>
                  <span className="text-gray-300">·</span>
                  <button onClick={clearAllLocations} className="text-gray-500 hover:underline">
                    None
                  </button>
                </div>
              )
            }
          >
            {locations.length === 0 ? (
              <div className="text-xs text-gray-500">
                No connected business profiles yet.
                <button
                  onClick={() => navigate('/connections')}
                  className="ml-1 text-primary-600 hover:underline"
                >
                  Connect one
                </button>
                .
              </div>
            ) : (
              <ul className="space-y-1 max-h-72 overflow-y-auto pr-1">
                {locations.map((loc) => {
                  const color = colorForLocation(loc.locationId, locations);
                  const checked = selectedLocationKeys.has(loc.key);
                  return (
                    <li key={loc.key}>
                      <label className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-gray-50 cursor-pointer">
                        <input
                          type="checkbox"
                          className="mt-1 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                          checked={checked}
                          onChange={() => toggleLocation(loc.key)}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className={`inline-block h-2 w-2 rounded-full ${color.dot}`} />
                            <span className="text-sm text-gray-900 truncate">{loc.title}</span>
                          </span>
                          {loc.addressLine && (
                            <span className="block text-xs text-gray-500 truncate">
                              {loc.addressLine}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </FilterCard>

          <FilterCard
            title={`Drafts${drafts.length > 0 ? ` (${drafts.length})` : ''}`}
            headerRight={
              <button
                type="button"
                onClick={loadDrafts}
                disabled={draftsLoading}
                className="text-xs text-primary-600 hover:underline disabled:opacity-50"
              >
                <RefreshCw className={`h-3 w-3 inline ${draftsLoading ? 'animate-spin' : ''}`} />
              </button>
            }
          >
            {drafts.length === 0 ? (
              <div className="text-xs text-gray-500">
                No drafts yet. Use "Save as draft" in the composer to keep an idea for later.
              </div>
            ) : (
              <ul className="space-y-1 max-h-56 overflow-y-auto pr-1">
                {drafts.map((d) => {
                  const preview = (d.content || '').trim() || <span className="italic text-gray-400">(empty)</span>;
                  return (
                    <li key={d.id} className="group">
                      <div className="flex items-start gap-1 py-1.5 px-2 rounded hover:bg-gray-50">
                        <button
                          type="button"
                          onClick={() => openDraft(d)}
                          className="flex-1 min-w-0 text-left"
                          title="Open in composer"
                        >
                          <span className="block text-sm text-gray-900 truncate">
                            {typeof preview === 'string' ? preview.slice(0, 60) : preview}
                          </span>
                          <span className="block text-[11px] text-gray-500">
                            {new Date(d.updated_at || d.created_at).toLocaleDateString()}
                            {Array.isArray(d.media) && d.media.length > 0 ? ` · ${d.media.length} image${d.media.length === 1 ? '' : 's'}` : ''}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteDraft(d.id)}
                          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1"
                          title="Delete draft"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </FilterCard>
        </aside>

        {/* Grid */}
        <section className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border-b border-gray-200">
            <div className="flex items-center gap-1">
              {['month', 'week'].map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                    view === v
                      ? 'bg-primary-600 text-white border-primary-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
              <button
                onClick={goToday}
                className="ml-2 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
              >
                Today
              </button>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={goPrev}
                className="p-1.5 rounded-md border border-gray-300 hover:bg-gray-50"
                aria-label="Previous"
              >
                <ChevronLeft className="h-4 w-4 text-gray-700" />
              </button>
              <div className="min-w-[10rem] text-center text-sm font-medium text-gray-900">
                {view === 'month' ? monthLabel : weekLabel}
              </div>
              <button
                onClick={goNext}
                className="p-1.5 rounded-md border border-gray-300 hover:bg-gray-50"
                aria-label="Next"
              >
                <ChevronRight className="h-4 w-4 text-gray-700" />
              </button>
            </div>
          </div>

          {error && (
            <div className="m-4 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-800">
              {error}
            </div>
          )}

          {loading ? (
            <div className="p-16 flex items-center justify-center">
              <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-primary-600" />
            </div>
          ) : (
            <MonthWeekGrid
              days={days}
              view={view}
              anchor={anchor}
              today={today}
              itemsByDay={itemsByDay}
              allLocations={locations}
              onPillClick={setDetailItem}
              onEmptyClick={openCreateForDate}
            />
          )}
        </section>
      </div>

      {detailItem && (
        <DetailModal
          item={detailItem}
          location={locations.find(
            (l) => l.key === `${detailItem.accountId || ''}:${detailItem.locationId || ''}`
          )}
          allLocations={locations}
          onClose={() => setDetailItem(null)}
          onCancelled={handleCancelled}
        />
      )}

      {scheduleModal && (
        <PostComposerModal
          defaultDate={scheduleModal.defaultDate}
          initialDraft={scheduleModal.draft || null}
          profiles={profiles}
          locations={locations}
          selectedLocationKeys={selectedLocationKeys}
          onReloadAccounts={loadAccounts}
          onClose={() => setScheduleModal(null)}
          onDone={handleScheduled}
        />
      )}
    </div>
  );
};

// ── Sidebar card ───────────────────────────────────────────

const FilterCard = ({ title, headerRight, children }) => (
  <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {headerRight}
    </div>
    {children}
  </div>
);

// ── Grid (month or week) ───────────────────────────────────

const MonthWeekGrid = ({ days, view, anchor, today, itemsByDay, allLocations, onPillClick, onEmptyClick }) => {
  const rows = view === 'month' ? 6 : 1;

  return (
    <div>
      <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div key={d} className="p-2 text-xs font-medium text-gray-500 text-center">
            {d}
          </div>
        ))}
      </div>
      <div
        className="grid grid-cols-7"
        style={{ gridAutoRows: view === 'month' ? 'minmax(7rem, auto)' : 'minmax(20rem, auto)' }}
      >
        {days.map((day, idx) => {
          const dayKey = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
          const dayItems = itemsByDay.get(dayKey) || [];
          const isOtherMonth = view === 'month' && day.getMonth() !== anchor.getMonth();
          const isToday = sameDay(day, today);
          const isWeekendCol = idx % 7 === 0 || idx % 7 === 6;

          return (
            <DayCell
              key={dayKey + '-' + idx}
              day={day}
              items={dayItems}
              allLocations={allLocations}
              isOtherMonth={isOtherMonth}
              isToday={isToday}
              isWeekendCol={isWeekendCol}
              onPillClick={onPillClick}
              onEmptyClick={onEmptyClick}
              rows={rows}
            />
          );
        })}
      </div>
    </div>
  );
};

const DayCell = ({ day, items, allLocations, isOtherMonth, isToday, isWeekendCol, onPillClick, onEmptyClick, rows }) => {
  const maxVisible = rows === 6 ? 3 : 12;
  const visible = items.slice(0, maxVisible);
  const overflow = items.length - visible.length;

  return (
    <div
      className={`relative border-b border-r border-gray-200 p-1.5 flex flex-col gap-1 group cursor-pointer ${
        isOtherMonth ? 'bg-gray-50/60' : isWeekendCol ? 'bg-white' : 'bg-white'
      } ${isToday ? 'ring-2 ring-inset ring-primary-500' : ''} hover:bg-gray-50/80`}
      onClick={(e) => {
        // Only respond to clicks on the cell itself, not on pills.
        if (e.target === e.currentTarget || e.currentTarget.contains(e.target)) {
          // Pills stop propagation, so this only fires for background clicks.
          onEmptyClick(day);
        }
      }}
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-xs font-medium ${
            isToday
              ? 'inline-flex items-center justify-center h-6 w-6 rounded-full bg-primary-600 text-white'
              : isOtherMonth
              ? 'text-gray-400'
              : 'text-gray-700'
          }`}
        >
          {day.getDate()}
        </span>
      </div>
      <div className="flex-1 flex flex-col gap-1 overflow-hidden">
        {visible.map((item) => {
          const color = colorForLocation(item.locationId, allLocations);
          const isScheduled = item.kind === 'scheduled';
          return (
            <button
              key={item.kind + '-' + item.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPillClick(item);
              }}
              className={`text-left rounded border ${color.border} ${color.bg} px-1.5 py-1 hover:brightness-95 transition-all`}
              title={item.content}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`h-1.5 w-1.5 rounded-full flex-none ${color.dot}`} />
                <span className={`text-[11px] font-medium ${color.text} truncate flex-1`}>
                  {truncate(item.content, 40) || (isScheduled ? 'Scheduled post' : 'Post')}
                </span>
                {isScheduled && (
                  <Clock className="h-3 w-3 text-gray-500 flex-none" />
                )}
              </div>
              <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1">
                {fmtTime(item._date)}
                {item.thumbUrl && <ImageIcon className="h-3 w-3" />}
              </div>
            </button>
          );
        })}
        {overflow > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // Show the first hidden item's day — for now just open the
              // first overflow item in the detail modal.
              onPillClick(items[maxVisible]);
            }}
            className="text-[11px] text-primary-600 hover:underline text-left"
          >
            +{overflow} more
          </button>
        )}
      </div>
    </div>
  );
};

// ── Detail modal ───────────────────────────────────────────

const DetailModal = ({ item, location, allLocations, onClose, onCancelled }) => {
  const when = new Date(item.when);
  const color = colorForLocation(item.locationId, allLocations);
  const isScheduled = item.kind === 'scheduled';
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(null);

  const handleCancel = async () => {
    if (!isScheduled) return;
    // eslint-disable-next-line no-restricted-globals, no-alert
    if (!window.confirm('Cancel this scheduled post? It will not be published.')) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await calendarService.cancel(item.id);
      onCancelled?.();
    } catch (err) {
      setCancelError(err?.response?.data?.error || err?.message || 'Failed to cancel');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-5 border-b border-gray-200">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`h-2.5 w-2.5 rounded-full flex-none ${color.dot}`} />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900 truncate">
                {location?.title || 'Business post'}
              </div>
              <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                    isScheduled
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-emerald-100 text-emerald-800'
                  }`}
                >
                  {isScheduled ? <Clock className="h-3 w-3" /> : <CalendarIcon className="h-3 w-3" />}
                  {isScheduled ? 'Scheduled' : 'Published'}
                </span>
                <span>
                  {when.toLocaleDateString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}{' '}
                  · {fmtTime(when)}
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {item.thumbUrl && (
          <div className="border-b border-gray-200">
            <img
              src={item.thumbUrl}
              alt=""
              className="w-full max-h-72 object-cover"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          </div>
        )}

        <div className="p-5">
          <div className="text-sm text-gray-800 whitespace-pre-wrap">
            {item.content || <span className="text-gray-400 italic">No content</span>}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs text-gray-600">
            <div>
              <dt className="font-medium text-gray-500">Platform</dt>
              <dd className="mt-0.5 capitalize">{item.platform}</dd>
            </div>
            <div>
              <dt className="font-medium text-gray-500">Location ID</dt>
              <dd className="mt-0.5 font-mono truncate">{item.locationId || '—'}</dd>
            </div>
          </dl>
        </div>

        {cancelError && (
          <div className="mx-4 mb-3 p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
            {cancelError}
          </div>
        )}
        <div className="p-4 border-t border-gray-200 flex justify-between gap-2">
          <div>
            {isScheduled && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-700 bg-white border border-red-300 rounded-md hover:bg-red-50 disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Close
            </button>
            {item.kind === 'published' && item.locationId && item.accountId && (
              <a
                href={`/posts`}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700"
              >
                <ExternalLink className="h-4 w-4" />
                Open in Posts
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Post composer modal ────────────────────────────────────
//
// Full-parity composer for the calendar. Mirrors the fields of the Posts.js
// create form (post type toggle, description with 1500-char counter, media
// URLs list, direct file upload, CTA type + URL, live preview column) and
// adds a "Publish now / Schedule for later" toggle so one modal covers
// both creation flows.
//
// Business-profile picker iterates the raw `profiles.map → locations.map`
// tree — same shape Posts.js uses — so every connected account + location
// appears, not just the ones my earlier flatten kept.

const toLocalInputValue = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// (accountId, locationId) from an "accounts/X/locations/Y" full path.
const splitFullPath = (fullPath) => {
  if (!fullPath) return { accountId: null, locationId: null };
  const parts = fullPath.split('/');
  return {
    accountId: parts[1] || null,
    locationId: parts[parts.length - 1] || null,
  };
};

// CTA_OPTIONS, POST_TYPES, isCallCta, digitsOnly, looksLikePhone, toTelUrl
// live in composerShared.js — imported at the top of this file.

const PostComposerModal = ({ defaultDate, profiles, locations, selectedLocationKeys, onReloadAccounts, onClose, onDone, initialDraft }) => {
  // Flat list of every profile × location combo the user can pick.
  const allLocationOptions = useMemo(() => {
    const out = [];
    (profiles || []).forEach((profile) => {
      (profile.locations || []).forEach((loc) => {
        if (!loc.fullPath) return;
        out.push({
          fullPath: loc.fullPath,
          accountLabel: profile.accountName || profile.displayName || 'Google Account',
          accountEmail: profile.connected_via_email || null,
          accountGoogleId: profile.connected_via_google_id || null,
          title: loc.title || loc.locationName || 'Untitled Location',
          key: (profile?.name?.split('/').pop() || '') + ':' + (loc?.name?.split('/').pop() || ''),
        });
      });
    });
    return out;
  }, [profiles]);

  // Preselect: from a draft, or everything the sidebar had checked, or
  // the first available location.
  const initialPaths = useMemo(() => {
    if (initialDraft?.gmb_account_id && initialDraft?.location_id) {
      return [`accounts/${initialDraft.gmb_account_id}/locations/${initialDraft.location_id}`];
    }
    const checked = selectedLocationKeys || new Set();
    const hits = allLocationOptions.filter((o) => checked.has(o.key));
    if (hits.length > 0) return hits.map((o) => o.fullPath);
    if (allLocationOptions.length > 0) return [allLocationOptions[0].fullPath];
    return [];
  }, [allLocationOptions, selectedLocationKeys, initialDraft]);

  const isFutureDefault = defaultDate && new Date(defaultDate).getTime() > Date.now() + 60_000;

  // When editing a draft, prefill everything from the draft row.
  const initialMediaUrls = useMemo(() => {
    const arr = Array.isArray(initialDraft?.media)
      ? initialDraft.media.map((m) => (typeof m === 'string' ? m : m?.sourceUrl || m?.url || ''))
      : [];
    return arr.length > 0 ? arr : [''];
  }, [initialDraft]);

  const [locationPaths, setLocationPaths] = useState(initialPaths);
  const [when, setWhen] = useState(() => toLocalInputValue(new Date(defaultDate || Date.now() + 60 * 60 * 1000)));
  const [mode, setMode] = useState(isFutureDefault ? 'later' : 'now'); // 'now' | 'later'
  const [postType, setPostType] = useState(initialDraft?.post_type || 'UPDATE');
  const [summary, setSummary] = useState(initialDraft?.content || '');
  const [mediaUrls, setMediaUrls] = useState(initialMediaUrls);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [callToAction, setCallToAction] = useState(
    initialDraft?.call_to_action
      ? {
          type: initialDraft.call_to_action.actionType || '',
          // For CALL, strip the tel: prefix so the user can edit the raw number.
          url: initialDraft.call_to_action.actionType === 'CALL'
            ? (initialDraft.call_to_action.url || '').replace(/^tel:/i, '')
            : initialDraft.call_to_action.url || '',
        }
      : { type: '', url: '' }
  );
  const draftId = initialDraft?.id || null;
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [reloading, setReloading] = useState(false);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiJustFilled, setAiJustFilled] = useState(false);
  const [aiImageDescriptions, setAiImageDescriptions] = useState([]);
  // After submit, per-location outcomes: { fullPath, title, ok, error? }
  const [postResults, setPostResults] = useState(null);

  const accountsCount = (profiles || []).filter((p) => (p.locations || []).length > 0).length;
  const locationsCount = (profiles || []).reduce((acc, p) => acc + (p.locations?.length || 0), 0);

  const handleReload = async () => {
    if (!onReloadAccounts) return;
    setReloading(true);
    try {
      await onReloadAccounts(true);
    } finally {
      setReloading(false);
    }
  };

  const setUrlAt = (idx, value) => {
    setMediaUrls((prev) => prev.map((u, i) => (i === idx ? value : u)));
  };
  const addUrlRow = () => setMediaUrls((prev) => [...prev, '']);
  const removeUrlRow = (idx) => {
    setMediaUrls((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length === 0 ? [''] : next;
    });
  };

  const handleFileInput = (e) => {
    const files = Array.from(e.target.files || []);
    setUploadedFiles((prev) => [...prev, ...files]);
    e.target.value = '';
  };
  const removeFile = (idx) => setUploadedFiles((prev) => prev.filter((_, i) => i !== idx));

  const validUrls = mediaUrls.map((u) => u.trim()).filter(Boolean);
  const previewImage = validUrls[0] || null;
  const charCount = summary.length;

  const handleGenerateAi = async () => {
    setAiError(null);
    setAiJustFilled(false);
    if (validUrls.length === 0) {
      setAiError('Add at least one image URL first — the AI writes the caption from what it sees.');
      return;
    }
    // Pull business context from the first picked location so the caption
    // sounds grounded. Multi-account posts share the same caption anyway.
    const primaryPath = locationPaths[0] || '';
    const target =
      (profiles || [])
        .flatMap((p) => (p.locations || []).map((l) => ({ ...l, accountName: p.accountName || p.displayName })))
        .find((l) => l.fullPath === primaryPath) || null;
    const businessName = target?.title || target?.locationName || target?.accountName || 'the business';
    const businessType =
      target?.primaryCategory?.displayName ||
      target?.categories?.primaryCategory?.displayName ||
      'local service business';
    const city =
      target?.storefrontAddress?.locality ||
      target?.address?.locality ||
      '';

    setAiGenerating(true);
    setAiImageDescriptions([]);
    try {
      const resp = await axios.post(
        '/api/ai/post-from-image',
        {
          // GBP supports up to ~10 photos per post; matches the backend cap.
          imageUrls: validUrls.slice(0, 10),
          businessName,
          businessType,
          city,
          postType,
          includeCallToAction: !!callToAction.type,
          ctaType: callToAction.type || null,
        },
        // Vision on 8-10 images: server-side fetch of each Drive file +
        // base64 + OpenAI vision inference. 90s inline cap so the frontend
        // isn't the bottleneck.
        { timeout: 120000 }
      );
      if (resp.data?.text) {
        setSummary(resp.data.text);
        setAiJustFilled(true);
        setAiImageDescriptions(Array.isArray(resp.data.imageDescriptions) ? resp.data.imageDescriptions : []);
      } else {
        setAiError('AI returned an empty response — try again or edit manually.');
      }
    } catch (err) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.error || err?.message;
      if (status === 429) {
        setAiError(`Daily AI cap reached (${err?.response?.data?.used}/${err?.response?.data?.cap}).`);
      } else {
        setAiError(detail || 'AI generation failed');
      }
    } finally {
      setAiGenerating(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setPostResults(null);

    if (!summary.trim()) {
      setError('Description is required.');
      return;
    }
    if (!Array.isArray(locationPaths) || locationPaths.length === 0) {
      setError('Pick at least one business profile.');
      return;
    }
    for (const u of validUrls) {
      try {
        // eslint-disable-next-line no-new
        new URL(u);
      } catch {
        setError(`Invalid image URL: ${u}`);
        return;
      }
    }
    if (callToAction.type) {
      const raw = (callToAction.url || '').trim();
      if (!raw) {
        setError(
          isCallCta(callToAction.type)
            ? 'Add a phone number for the Call now button, or clear the CTA type.'
            : 'Add a URL for the call to action, or clear the CTA type.'
        );
        return;
      }
      if (isCallCta(callToAction.type) && !looksLikePhone(raw)) {
        setError('Enter a valid phone number (7-15 digits, optional leading +).');
        return;
      }
      if (!isCallCta(callToAction.type)) {
        try {
          // eslint-disable-next-line no-new
          new URL(raw);
        } catch {
          setError(`Enter a valid URL for the ${CTA_OPTIONS.find(o => o.v === callToAction.type)?.label} action.`);
          return;
        }
      }
    }

    // Precompute the CTA payload once — same across every location.
    const ctaPayload =
      callToAction.type && callToAction.url.trim()
        ? {
            actionType: callToAction.type,
            url: isCallCta(callToAction.type)
              ? toTelUrl(callToAction.url)
              : callToAction.url.trim(),
          }
        : null;

    // Schedule-mode preconditions.
    let scheduledDate = null;
    if (mode === 'later') {
      if (uploadedFiles.length > 0) {
        setError('Direct file uploads are not yet supported for scheduled posts — paste image URLs instead.');
        return;
      }
      scheduledDate = new Date(when);
      if (Number.isNaN(scheduledDate.getTime())) {
        setError('Invalid scheduled time.');
        return;
      }
      if (scheduledDate.getTime() < Date.now() - 60_000) {
        setError('Scheduled time must be in the future.');
        return;
      }
    }

    setSubmitting(true);

    // Fan out across every picked location. Promise.allSettled so one
    // 500 doesn't block the rest — users see per-location outcomes below.
    const runOne = async (fullPath) => {
      const { accountId, locationId } = splitFullPath(fullPath);
      const option = allLocationOptions.find((o) => o.fullPath === fullPath);
      const title = option?.title || fullPath;
      if (!accountId || !locationId) {
        throw new Error('Malformed profile path');
      }
      if (mode === 'now') {
        const fd = new FormData();
        fd.append('platforms', JSON.stringify(['google']));
        fd.append('content', summary.trim());
        fd.append('gmbAccountId', accountId);
        fd.append('gmbLocationId', locationId);
        fd.append('postType', postType);
        if (ctaPayload) fd.append('callToAction', JSON.stringify(ctaPayload));
        if (validUrls.length > 0) {
          fd.append('media', JSON.stringify(validUrls.slice(0, 1).map((sourceUrl) => ({ mediaFormat: 'PHOTO', sourceUrl }))));
        }
        uploadedFiles.forEach((f) => fd.append('images', f));
        await axios.post('/api/posts', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      } else {
        await calendarService.schedule({
          content: summary.trim(),
          media: validUrls.slice(0, 1).map((sourceUrl) => ({ sourceUrl, mediaFormat: 'PHOTO' })),
          gmbAccountId: accountId,
          gmbLocationId: locationId,
          scheduledTime: scheduledDate,
          postType,
          callToAction: ctaPayload,
        });
      }
      return { fullPath, title, ok: true };
    };

    const settled = await Promise.allSettled(locationPaths.map(runOne));
    const results = settled.map((s, i) => {
      const fullPath = locationPaths[i];
      const option = allLocationOptions.find((o) => o.fullPath === fullPath);
      const title = option?.title || fullPath;
      if (s.status === 'fulfilled') return { fullPath, title, ok: true };
      const err = s.reason;
      return {
        fullPath,
        title,
        ok: false,
        error: err?.response?.data?.error || err?.message || 'Failed',
      };
    });
    setPostResults(results);
    setSubmitting(false);

    // If every location succeeded and we were editing a draft, delete
    // the draft row so it doesn't linger in the drafts list. Non-fatal.
    if (results.every((r) => r.ok) && draftId) {
      try {
        await calendarService.deleteDraft(draftId);
      } catch { /* non-fatal */ }
    }

    // Remember CTA URL / phone across future composer opens.
    if (results.every((r) => r.ok) && callToAction.type && callToAction.url?.trim()) {
      if (isCallCta(callToAction.type)) rememberPhone(callToAction.url.trim());
      else rememberUrl(callToAction.url.trim());
    }

    // If every location succeeded, close and refresh. Otherwise leave the
    // modal open so the user can see per-location failures.
    if (results.every((r) => r.ok)) {
      onDone?.();
    }
  };

  // Save-as-draft: idempotent — if we're editing an existing draft this
  // updates it, otherwise inserts a new one. Distinct from the multi-step
  // publish/schedule submit; no per-location fanout, no validation beyond
  // "you're logged in and picked something".
  const handleSaveDraft = async () => {
    setError(null);
    setSavingDraft(true);
    try {
      const primaryPath = locationPaths[0] || '';
      const { accountId, locationId } = splitFullPath(primaryPath);
      const ctaPayload =
        callToAction.type && callToAction.url.trim()
          ? {
              actionType: callToAction.type,
              url: isCallCta(callToAction.type)
                ? toTelUrl(callToAction.url)
                : callToAction.url.trim(),
            }
          : null;
      const payload = {
        content: summary,
        media: validUrls.slice(0, 1).map((sourceUrl) => ({ sourceUrl, mediaFormat: 'PHOTO' })),
        gmbAccountId: accountId || null,
        gmbLocationId: locationId || null,
        postType,
        callToAction: ctaPayload,
      };
      if (draftId) {
        await calendarService.updateDraft(draftId, payload);
      } else {
        await calendarService.saveDraft(payload);
      }
      setDraftSavedAt(new Date());
      // Refresh parent list on save so the drafts count updates.
      onDone?.({ keepOpen: true });
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to save draft');
    } finally {
      setSavingDraft(false);
    }
  };

  const hasProfiles = (profiles || []).some((p) => (p.locations || []).length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-200 sticky top-0 bg-white z-10">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {mode === 'later' ? 'Schedule a post' : 'New post'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {mode === 'later'
                ? 'Publisher will POST to Google Business Profile at the scheduled time.'
                : 'Publish immediately to Google Business Profile.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {!hasProfiles && (
            <div className="p-3 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-900">
              No connected business profiles. Connect one first from the Connections page.
            </div>
          )}

          {/* Row: profile picker + timing */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700">
                  Business profiles
                  <span className="ml-2 text-xs font-normal text-gray-500">
                    ({locationPaths.length} selected)
                  </span>
                </label>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <button
                    type="button"
                    onClick={() => setLocationPaths(allLocationOptions.map((o) => o.fullPath))}
                    className="text-primary-600 hover:underline"
                  >
                    All
                  </button>
                  <span className="text-gray-300">·</span>
                  <button
                    type="button"
                    onClick={() => setLocationPaths([])}
                    className="text-gray-500 hover:underline"
                  >
                    Clear
                  </button>
                  <span className="text-gray-300">·</span>
                  <button
                    type="button"
                    onClick={handleReload}
                    disabled={reloading}
                    className="inline-flex items-center gap-1 text-primary-600 hover:underline disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${reloading ? 'animate-spin' : ''}`} />
                    Reload
                  </button>
                </div>
              </div>
              <div className="rounded-md border border-gray-300 max-h-40 overflow-y-auto divide-y divide-gray-100 bg-white">
                {allLocationOptions.length === 0 ? (
                  <div className="p-3 text-xs text-gray-500">
                    No connected business profiles found.
                  </div>
                ) : (
                  allLocationOptions.map((opt) => {
                    const checked = locationPaths.includes(opt.fullPath);
                    return (
                      <label
                        key={opt.key}
                        className="flex items-start gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                          checked={checked}
                          onChange={() =>
                            setLocationPaths((prev) =>
                              checked
                                ? prev.filter((p) => p !== opt.fullPath)
                                : [...prev, opt.fullPath]
                            )
                          }
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm text-gray-900 truncate">{opt.title}</span>
                          <span className="block text-[11px] text-gray-500 truncate">
                            {opt.accountLabel}
                            {opt.accountEmail ? ` · ${opt.accountEmail}` : ''}
                          </span>
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500">
                The same post will publish{mode === 'later' ? '/schedule' : ''} to every selected
                profile — one API call per location.
              </p>
              {accountsCount === 0 && locationsCount === 0 && (
                <p className="text-xs text-amber-700 mt-1">
                  No locations returned by the GMB API. Try Reload; if still empty, reconnect the
                  profile from Integrations.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">When</label>
              <div className="flex items-center gap-1 mb-2">
                <button
                  type="button"
                  onClick={() => setMode('now')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                    mode === 'now'
                      ? 'bg-primary-600 text-white border-primary-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  Publish now
                </button>
                <button
                  type="button"
                  onClick={() => setMode('later')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                    mode === 'later'
                      ? 'bg-primary-600 text-white border-primary-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  Schedule for later
                </button>
              </div>
              {mode === 'later' && (
                <input
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                />
              )}
            </div>
          </div>

          {/* Post type toggle — matches Posts.js */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-gray-700">Post Type:</span>
            <div className="flex bg-gray-100 rounded-lg p-1">
              {POST_TYPES.map((pt) => (
                <button
                  key={pt.v}
                  type="button"
                  onClick={() => setPostType(pt.v)}
                  className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                    postType === pt.v
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {pt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Two-column body — matches Posts.js layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left column: form fields */}
            <div className="lg:col-span-2 space-y-4">
              {/* Media */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Add Pictures</label>

                {mode === 'now' ? (
                  <div className="mb-3">
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Upload Image Files (direct)
                    </label>
                    <input
                      type="file"
                      multiple
                      accept="image/*"
                      onChange={handleFileInput}
                      className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
                    />
                    {uploadedFiles.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {uploadedFiles.map((f, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800"
                          >
                            {f.name}
                            <button
                              type="button"
                              onClick={() => removeFile(idx)}
                              className="ml-1 text-green-600 hover:text-green-800"
                              aria-label="Remove file"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mb-3 p-2 rounded-md bg-gray-50 border border-gray-200 text-xs text-gray-600">
                    Scheduled posts currently support image URLs only — direct uploads coming soon.
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Image URL(s)</label>
                  {mediaUrls.map((u, idx) => (
                    <div key={idx} className="flex items-center gap-2 mb-2">
                      <input
                        type="url"
                        value={u}
                        onChange={(e) => setUrlAt(idx, e.target.value)}
                        placeholder="https://…"
                        className="block flex-1 border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => removeUrlRow(idx)}
                        className="p-1.5 text-gray-400 hover:text-red-600"
                        aria-label="Remove URL"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={addUrlRow}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add another URL
                    </button>
                    <span className="text-gray-300 text-xs">·</span>
                    <button
                      type="button"
                      onClick={() => setDrivePickerOpen(true)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
                    >
                      <HardDrive className="h-3.5 w-3.5" />
                      Pick from Google Drive
                    </button>
                  </div>
                </div>
              </div>

              {/* Description */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700">
                    Description
                    <span className="text-gray-500 font-normal ml-2">({charCount}/1500)</span>
                  </label>
                  <button
                    type="button"
                    onClick={handleGenerateAi}
                    disabled={aiGenerating || validUrls.length === 0}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                      aiGenerating || validUrls.length === 0
                        ? 'text-gray-400 border-gray-200 bg-white cursor-not-allowed'
                        : 'text-primary-700 border-primary-300 bg-primary-50 hover:bg-primary-100'
                    }`}
                    title={
                      validUrls.length === 0
                        ? 'Add at least one image URL to generate a caption from it'
                        : 'Write a caption from the selected image(s)'
                    }
                  >
                    <Sparkles className={`h-3.5 w-3.5 ${aiGenerating ? 'animate-pulse' : ''}`} />
                    {aiGenerating
                      ? 'Generating…'
                      : summary
                      ? 'Regenerate with AI'
                      : 'Generate with AI'}
                  </button>
                </div>
                <textarea
                  value={summary}
                  onChange={(e) => {
                    if (e.target.value.length <= 1500) setSummary(e.target.value);
                    if (aiJustFilled) setAiJustFilled(false);
                  }}
                  rows={5}
                  maxLength={1500}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  placeholder="Write your post content here…"
                  required
                />
                {aiError && (
                  <p className="mt-1 text-xs text-red-700">{aiError}</p>
                )}
                {aiJustFilled && (
                  <p className="mt-1 text-xs text-primary-700">
                    ✨ AI-generated from your image{validUrls.length > 1 ? 's' : ''} — edit before scheduling if anything is off.
                  </p>
                )}
                {aiImageDescriptions.length > 0 && (
                  <details className="mt-2 rounded-md border border-gray-200 bg-gray-50">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-700 select-none">
                      What the AI saw ({aiImageDescriptions.length} image{aiImageDescriptions.length === 1 ? '' : 's'})
                    </summary>
                    <ul className="px-3 pb-3 pt-1 space-y-1 text-xs text-gray-700">
                      {aiImageDescriptions.map((desc, i) => (
                        <li key={i}>
                          <span className="font-medium text-gray-500">Image {i + 1}:</span> {desc}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {/* CTA */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Call to Action Type</label>
                <select
                  value={callToAction.type}
                  onChange={(e) => {
                    const nextType = e.target.value;
                    setCallToAction((prev) => {
                      // Clear the URL/phone value when switching between
                      // phone- and URL-shaped inputs — the old value won't
                      // validate as the new kind and only confuses the user.
                      const switchingKind = isCallCta(prev.type) !== isCallCta(nextType);
                      return { type: nextType, url: switchingKind ? '' : prev.url };
                    });
                  }}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                >
                  {CTA_OPTIONS.map((o) => (
                    <option key={o.v || 'none'} value={o.v}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {callToAction.type && (
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {isCallCta(callToAction.type) ? 'Phone number' : 'Call to Action URL'}
                  </label>
                  <input
                    type={isCallCta(callToAction.type) ? 'tel' : 'url'}
                    list={isCallCta(callToAction.type) ? 'cta-phone-history' : 'cta-url-history'}
                    value={callToAction.url}
                    onChange={(e) => setCallToAction((prev) => ({ ...prev, url: e.target.value }))}
                    placeholder={isCallCta(callToAction.type) ? '(904) 902-0402' : 'https://example.com'}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  />
                  <datalist id="cta-url-history">
                    {getRecentUrls().map((u) => (
                      <option key={u} value={u} />
                    ))}
                  </datalist>
                  <datalist id="cta-phone-history">
                    {getRecentPhones().map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                  <p className="mt-1 text-xs text-gray-500">
                    {isCallCta(callToAction.type)
                      ? 'Customers will call this number when they tap the button.'
                      : 'Where the button sends people when tapped.'}
                  </p>
                </div>
              )}

              {error && (
                <div className="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
                  {error}
                </div>
              )}
            </div>

            {/* Right column: preview */}
            <div className="lg:col-span-1">
              <div className="sticky top-6">
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <h3 className="text-base font-medium text-gray-900 mb-3">Post Preview</h3>
                  <div className="space-y-3">
                    {validUrls.length === 0 ? (
                      <div className="w-full h-40 bg-gray-200 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center">
                        <div className="text-center">
                          <ImageIcon className="h-8 w-8 text-gray-400 mx-auto mb-1" />
                          <p className="text-xs text-gray-500">No images</p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {/* Hero: the first selected image */}
                        <SmartPreviewImage
                          url={validUrls[0]}
                          className="w-full h-48 object-cover rounded-lg border shadow-sm"
                        />
                        {/* Grid of the rest — 3 columns, square tiles, so
                            an 8-image set shows a hero + 7 in a 3x3-ish
                            grid without dominating the panel. */}
                        {validUrls.length > 1 && (
                          <div className="grid grid-cols-3 gap-1.5">
                            {validUrls.slice(1).map((u, i) => (
                              <SmartPreviewImage
                                key={u + i}
                                url={u}
                                className="w-full aspect-square object-cover rounded border"
                              />
                            ))}
                          </div>
                        )}
                        <div className="text-[10px] text-gray-500 text-right">
                          {validUrls.length} image{validUrls.length === 1 ? '' : 's'}
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-gray-900 leading-relaxed">
                      {summary
                        ? summary.length > 150
                          ? `${summary.substring(0, 150)}…`
                          : summary
                        : <span className="text-gray-400 italic">No content yet</span>}
                    </p>
                    <div>
                      <div className="text-xs font-medium text-gray-500 mb-1">
                        {mode === 'later'
                          ? new Date(when || Date.now()).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })
                          : new Date().toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                      </div>
                      {callToAction.type ? (
                        <a
                          href={callToAction.url || '#'}
                          className={`text-primary-600 hover:text-primary-700 text-sm font-medium ${
                            !callToAction.url ? 'pointer-events-none' : ''
                          }`}
                        >
                          {CTA_OPTIONS.find((o) => o.v === callToAction.type)?.label || callToAction.type}
                        </a>
                      ) : (
                        <span className="text-sm text-gray-400 italic">No CTA</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Per-location results (shown after any failed run) */}
        {postResults && postResults.some((r) => !r.ok) && (
          <div className="mx-6 mb-2 rounded-md border border-amber-200 bg-amber-50 p-3">
            <div className="text-xs font-semibold text-amber-900 mb-1">
              {postResults.filter((r) => r.ok).length} of {postResults.length} succeeded
            </div>
            <ul className="text-xs space-y-0.5">
              {postResults.map((r) => (
                <li key={r.fullPath} className={r.ok ? 'text-emerald-800' : 'text-red-800'}>
                  {r.ok ? '✓' : '✗'} {r.title}
                  {!r.ok && r.error ? ` — ${r.error}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2 sticky bottom-0 bg-white">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            {draftSavedAt && (
              <span className="text-xs text-gray-500">
                Saved {draftSavedAt.toLocaleTimeString()}
              </span>
            )}
            <button
              type="button"
              onClick={handleSaveDraft}
              disabled={savingDraft || submitting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-60"
            >
              {savingDraft ? 'Saving…' : draftId ? 'Update draft' : 'Save as draft'}
            </button>
            <button
              type="submit"
              disabled={submitting || !hasProfiles || locationPaths.length === 0}
              className="inline-flex items-center gap-1.5 px-5 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-60"
            >
              {mode === 'later' ? <Clock className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {submitting
                ? mode === 'later'
                  ? `Scheduling to ${locationPaths.length}…`
                  : `Publishing to ${locationPaths.length}…`
                : mode === 'later'
                  ? `Schedule${locationPaths.length > 1 ? ` to ${locationPaths.length} profiles` : ''}`
                  : `Publish${locationPaths.length > 1 ? ` to ${locationPaths.length} profiles` : ''}`}
            </button>
          </div>
        </div>
      </form>

      {drivePickerOpen && (
        <DrivePickerModal
          existingUrls={validUrls}
          // Scope by default only when the composer targets a single
          // location — a multi-account post should default to browsing
          // every Drive so the user can grab shared/general assets. The
          // dropdown in the picker header always lets them narrow later.
          initialGoogleId={
            locationPaths.length === 1
              ? (() => {
                  const parts = (locationPaths[0] || '').split('/');
                  const accId = parts[1];
                  const acct = (profiles || []).find(
                    (p) => (p?.name || '').split('/').pop() === accId
                  );
                  return acct?.connected_via_google_id || null;
                })()
              : null
          }
          initialEmail={
            locationPaths.length === 1
              ? (() => {
                  const parts = (locationPaths[0] || '').split('/');
                  const accId = parts[1];
                  const acct = (profiles || []).find(
                    (p) => (p?.name || '').split('/').pop() === accId
                  );
                  return acct?.connected_via_email || null;
                })()
              : null
          }
          onClose={() => setDrivePickerOpen(false)}
          onPick={(picked) => {
            // Insert every selected URL into the media list, filling any empty
            // rows first before appending new ones.
            setMediaUrls((prev) => {
              const next = [...prev];
              for (const url of picked) {
                if (next.includes(url)) continue;
                const emptyIdx = next.findIndex((v) => !v || !v.trim());
                if (emptyIdx >= 0) next[emptyIdx] = url;
                else next.push(url);
              }
              return next;
            });
            setDrivePickerOpen(false);
          }}
        />
      )}
    </div>
  );
};


export default Calendar;
