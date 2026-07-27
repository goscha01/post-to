import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
import driveService from '../services/driveService';

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
        addressLine: loc?.storefrontAddress?.locality || loc?.address || '',
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
  const [scheduleModal, setScheduleModal] = useState(null); // { defaultDate }

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

  const handleScheduled = () => {
    setScheduleModal(null);
    fetchRange({ silent: true });
  };

  const handleCancelled = () => {
    setDetailItem(null);
    fetchRange({ silent: true });
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

const CTA_OPTIONS = [
  { v: '', label: 'None' },
  { v: 'BOOK', label: 'Book' },
  { v: 'ORDER', label: 'Order' },
  { v: 'SHOP', label: 'Shop' },
  { v: 'LEARN_MORE', label: 'Learn more' },
  { v: 'SIGN_UP', label: 'Sign up' },
  { v: 'CALL', label: 'Call' },
];

const POST_TYPES = [
  { v: 'UPDATE', label: 'Update' },
  { v: 'OFFER', label: 'Offer' },
  { v: 'EVENT', label: 'Event' },
];

const PostComposerModal = ({ defaultDate, profiles, locations, selectedLocationKeys, onReloadAccounts, onClose, onDone }) => {
  // Preselect the first sidebar-checked location, then first available.
  const initialLocation = useMemo(() => {
    const checkedKey = [...(selectedLocationKeys || [])][0];
    if (checkedKey) {
      const hit = locations.find((l) => l.key === checkedKey);
      if (hit) return `accounts/${hit.accountId}/locations/${hit.locationId}`;
    }
    // Fall back to the first location on the first profile.
    for (const p of profiles || []) {
      for (const l of p.locations || []) {
        if (l.fullPath) return l.fullPath;
      }
    }
    return '';
  }, [profiles, locations, selectedLocationKeys]);

  const isFutureDefault = defaultDate && new Date(defaultDate).getTime() > Date.now() + 60_000;

  const [locationPath, setLocationPath] = useState(initialLocation);
  const [when, setWhen] = useState(() => toLocalInputValue(new Date(defaultDate || Date.now() + 60 * 60 * 1000)));
  const [mode, setMode] = useState(isFutureDefault ? 'later' : 'now'); // 'now' | 'later'
  const [postType, setPostType] = useState('UPDATE');
  const [summary, setSummary] = useState('');
  const [mediaUrls, setMediaUrls] = useState(['']);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [callToAction, setCallToAction] = useState({ type: '', url: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [reloading, setReloading] = useState(false);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiJustFilled, setAiJustFilled] = useState(false);

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
    // Pull business context from the picked location so the caption sounds
    // grounded in the actual business.
    const target =
      (profiles || [])
        .flatMap((p) => (p.locations || []).map((l) => ({ ...l, accountName: p.accountName || p.displayName })))
        .find((l) => l.fullPath === locationPath) || null;
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
    try {
      const resp = await axios.post('/api/ai/post-from-image', {
        imageUrls: validUrls.slice(0, 4),
        businessName,
        businessType,
        city,
        postType,
        includeCallToAction: !!callToAction.type,
        ctaType: callToAction.type || null,
      });
      if (resp.data?.text) {
        setSummary(resp.data.text);
        setAiJustFilled(true);
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

    if (!summary.trim()) {
      setError('Description is required.');
      return;
    }
    const { accountId, locationId } = splitFullPath(locationPath);
    if (!accountId || !locationId) {
      setError('Pick a business profile.');
      return;
    }
    // Guard bad URLs early — matches Posts.js validation.
    for (const u of validUrls) {
      try {
        // eslint-disable-next-line no-new
        new URL(u);
      } catch {
        setError(`Invalid image URL: ${u}`);
        return;
      }
    }
    if (callToAction.type && !callToAction.url.trim()) {
      setError('Add a URL for the call to action, or clear the CTA type.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'now') {
        // Multipart POST to /api/posts — same shape Posts.js uses.
        const fd = new FormData();
        fd.append('platforms', JSON.stringify(['google']));
        fd.append('content', summary.trim());
        fd.append('gmbAccountId', accountId);
        fd.append('gmbLocationId', locationId);
        fd.append('postType', postType);
        if (callToAction.type && callToAction.url.trim()) {
          fd.append(
            'callToAction',
            JSON.stringify({ actionType: callToAction.type, url: callToAction.url.trim() })
          );
        }
        if (validUrls.length > 0) {
          fd.append(
            'media',
            JSON.stringify(validUrls.map((sourceUrl) => ({ mediaFormat: 'PHOTO', sourceUrl })))
          );
        }
        uploadedFiles.forEach((f) => fd.append('images', f));
        await axios.post('/api/posts', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      } else {
        // Scheduled path — file uploads not supported yet on this endpoint.
        if (uploadedFiles.length > 0) {
          setError('Direct file uploads are not yet supported for scheduled posts — paste image URLs instead.');
          setSubmitting(false);
          return;
        }
        const scheduledDate = new Date(when);
        if (Number.isNaN(scheduledDate.getTime())) {
          setError('Invalid scheduled time.');
          setSubmitting(false);
          return;
        }
        if (scheduledDate.getTime() < Date.now() - 60_000) {
          setError('Scheduled time must be in the future.');
          setSubmitting(false);
          return;
        }
        await calendarService.schedule({
          content: summary.trim(),
          media: validUrls.map((sourceUrl) => ({ sourceUrl, mediaFormat: 'PHOTO' })),
          gmbAccountId: accountId,
          gmbLocationId: locationId,
          scheduledTime: scheduledDate,
          postType,
          callToAction:
            callToAction.type && callToAction.url.trim()
              ? { actionType: callToAction.type, url: callToAction.url.trim() }
              : null,
        });
      }
      onDone?.();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to submit');
    } finally {
      setSubmitting(false);
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
                <label className="block text-sm font-medium text-gray-700">Business profile</label>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <span>
                    {accountsCount} {accountsCount === 1 ? 'account' : 'accounts'} · {locationsCount}{' '}
                    {locationsCount === 1 ? 'location' : 'locations'}
                  </span>
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
              <select
                value={locationPath}
                onChange={(e) => setLocationPath(e.target.value)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                disabled={!hasProfiles}
              >
                <option value="">Select a profile…</option>
                {(profiles || []).map((profile, pi) =>
                  (profile.locations || []).map((location) => (
                    <option key={location.fullPath} value={location.fullPath}>
                      {(profile.accountName || profile.displayName || `Account ${pi + 1}`)}
                      {' — '}
                      {location.title || location.locationName || 'Untitled Location'}
                    </option>
                  ))
                )}
              </select>
              {locationsCount === 0 && (
                <p className="text-xs text-amber-700 mt-1">
                  No locations returned by the GMB API. Try Reload; if still empty, reconnect the
                  profile from Connections.
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
              </div>

              {/* CTA */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Call to Action Type</label>
                <select
                  value={callToAction.type}
                  onChange={(e) => setCallToAction((prev) => ({ ...prev, type: e.target.value }))}
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
                  <label className="block text-sm font-medium text-gray-700">Call to Action URL</label>
                  <input
                    type="url"
                    value={callToAction.url}
                    onChange={(e) => setCallToAction((prev) => ({ ...prev, url: e.target.value }))}
                    placeholder="https://example.com"
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  />
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
                    {previewImage ? (
                      <SmartPreviewImage
                        url={previewImage}
                        className="w-full h-48 object-cover rounded-lg border shadow-sm"
                      />
                    ) : (
                      <div className="w-full h-40 bg-gray-200 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center">
                        <div className="text-center">
                          <ImageIcon className="h-8 w-8 text-gray-400 mx-auto mb-1" />
                          <p className="text-xs text-gray-500">No images</p>
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
                          {callToAction.type.charAt(0) + callToAction.type.slice(1).toLowerCase().replace('_', ' ')}
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

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2 sticky bottom-0 bg-white">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !hasProfiles}
            className="inline-flex items-center gap-1.5 px-5 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-60"
          >
            {mode === 'later' ? <Clock className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {submitting
              ? mode === 'later' ? 'Scheduling…' : 'Publishing…'
              : mode === 'later' ? 'Schedule' : 'Publish'}
          </button>
        </div>
      </form>

      {drivePickerOpen && (
        <DrivePickerModal
          existingUrls={validUrls}
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

// ── Google Drive picker ────────────────────────────────────
//
// Grid overlay for browsing image files across every connected business
// profile's Google Drive. Each tile shows the file thumbnail, name, and an
// "Already used" pill for files whose filename matches a previous post.
// Selecting a tile inserts its public view URL into the composer's media
// URL list.

// SmartPreviewImage: renders any image URL, but for Google Drive URLs
// (drive.google.com/uc?...id=X) it swaps to the auth'd backend proxy so
// files that haven't been shared publicly still preview correctly. The
// public `uc?export=view&id=X` URL is kept for the final GMB payload
// (which still requires the file to be public for GMB to fetch it).
const extractDriveFileId = (url) => {
  if (!url || typeof url !== 'string') return null;
  let m = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  m = url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  return null;
};

const SmartPreviewImage = ({ url, className, alt = 'Preview' }) => {
  const [src, setSrc] = useState(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let blobUrl = null;
    setErrored(false);
    setSrc(null);
    if (!url) return () => {};

    const fileId = extractDriveFileId(url);
    if (!fileId) {
      setSrc(url);
      return () => {};
    }

    // Auth'd fetch via /api/drive/proxy — <img src> can't send Bearer
    // headers, so we fetch through axios and hand the browser a blob URL.
    (async () => {
      try {
        const resp = await axios.get(`/api/drive/proxy/${fileId}`, { responseType: 'blob' });
        if (cancelled) return;
        blobUrl = URL.createObjectURL(resp.data);
        setSrc(blobUrl);
      } catch (e) {
        if (!cancelled) setErrored(true);
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url]);

  if (errored) {
    return (
      <div className={`${className} bg-gray-100 flex items-center justify-center text-xs text-gray-500 text-center p-3`}>
        Couldn't load preview.
        <br />
        Make sure Drive access is granted.
      </div>
    );
  }
  if (!src) {
    return (
      <div className={`${className} bg-gray-100 animate-pulse`} />
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setErrored(true)}
    />
  );
};

const fileToPublicUrl = (file) => {
  // drive.google.com/uc?export=view&id=<id> is the canonical "download URL"
  // that other services (including GMB) can fetch — but only when the file's
  // Drive sharing is "Anyone with the link". Otherwise this returns HTML.
  // We surface a warning in the picker so users know to check sharing first.
  return `https://drive.google.com/uc?export=view&id=${file.id}`;
};

const DrivePickerModal = ({ existingUrls, onClose, onPick }) => {
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [selected, setSelected] = useState(() => new Set()); // ids of image files chosen so far
  const [selectedFiles, setSelectedFiles] = useState(new Map()); // id -> file object, preserved across folder navigation
  // Breadcrumb: empty array = My Drive root. Each entry: { id, name }.
  const [folderPath, setFolderPath] = useState([]);

  const currentFolderId = folderPath.length > 0 ? folderPath[folderPath.length - 1].id : '';
  // Search-mode: when the user types a query, we search across everything
  // (no folder scope) to match how users think of Drive search.
  const isSearching = !!debouncedQ;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setNeedsReauth(false);
      try {
        const data = await driveService.listImages({
          q: debouncedQ,
          pageSize: 100,
          folderId: isSearching ? '' : currentFolderId,
          // Show folders + images when browsing. In search mode we want
          // images only so results don't fill up with folder matches.
          type: isSearching ? 'images' : 'both',
        });
        if (cancelled) return;
        setItems(Array.isArray(data.items) ? data.items : []);
      } catch (err) {
        if (cancelled) return;
        const status = err?.response?.status;
        const code = err?.response?.data?.code;
        if (status === 403 && (code === 'DRIVE_NEEDS_REAUTH' || err?.response?.data?.needsReauth)) {
          setNeedsReauth(true);
          setError("Google Drive access hasn't been granted. Reconnect your business profile to enable it.");
        } else {
          setError(err?.response?.data?.error || err?.message || 'Failed to load Drive images');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, currentFolderId, isSearching]);

  const toggle = (file) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.add(file.id);
      return next;
    });
    setSelectedFiles((prev) => {
      const next = new Map(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.set(file.id, file);
      return next;
    });
  };

  const enterFolder = (folder) => {
    setFolderPath((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setQuery(''); // clear search when navigating
  };
  const gotoRoot = () => {
    setFolderPath([]);
    setQuery('');
  };
  const gotoCrumb = (idx) => {
    setFolderPath((prev) => prev.slice(0, idx + 1));
    setQuery('');
  };

  const confirm = () => {
    // Use the preserved selectedFiles map so choices made in one folder
    // survive when the user navigates to a different folder before hitting
    // Add.
    const urls = Array.from(selectedFiles.values()).map(fileToPublicUrl);
    onPick(urls);
  };

  const folders = items.filter((f) => f.isFolder);
  const files = items.filter((f) => !f.isFolder);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-primary-600" />
              Google Drive images
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Images across every connected business profile's Drive. Files already used in a post
              show an "Already used" badge.
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

        <div className="px-5 py-3 border-b border-gray-200 space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Drive images by name…"
              className="block w-full pl-9 pr-3 py-2 border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
            />
          </div>
          {/* Breadcrumb — hidden while searching (search is unscoped) */}
          {!isSearching && (
            <nav className="flex items-center gap-1 text-xs text-gray-600 flex-wrap">
              <button
                type="button"
                onClick={gotoRoot}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 ${
                  folderPath.length === 0 ? 'text-primary-700 font-medium' : ''
                }`}
              >
                <HomeIcon className="h-3.5 w-3.5" />
                My Drive
              </button>
              {folderPath.map((crumb, i) => (
                <React.Fragment key={crumb.id}>
                  <ChevronRightIcon className="h-3 w-3 text-gray-300" />
                  <button
                    type="button"
                    onClick={() => gotoCrumb(i)}
                    className={`px-2 py-1 rounded hover:bg-gray-100 truncate max-w-[12rem] ${
                      i === folderPath.length - 1 ? 'text-primary-700 font-medium' : ''
                    }`}
                    title={crumb.name}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </nav>
          )}
          {selectedFiles.size > 0 && (
            <div className="text-xs text-gray-500">
              {selectedFiles.size} selected across folders — will be added when you click "Add"
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="p-10 flex items-center justify-center">
              <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-primary-600" />
            </div>
          ) : error ? (
            <div className="p-4 rounded-md bg-red-50 border border-red-200 text-sm text-red-800">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-none" />
                <div className="flex-1">
                  <div>{error}</div>
                  {needsReauth && (
                    <a
                      href="/connections"
                      className="inline-block mt-2 text-primary-700 underline"
                    >
                      Go to Connections
                    </a>
                  )}
                </div>
              </div>
            </div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center text-sm text-gray-500">
              {debouncedQ
                ? 'No matches.'
                : folderPath.length > 0
                ? 'This folder is empty.'
                : 'No images or folders found in your Drive root.'}
            </div>
          ) : (
            <div className="space-y-4">
              {folders.length > 0 && !isSearching && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
                    Folders
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                    {folders.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => enterFolder(f)}
                        className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-left"
                      >
                        <Folder className="h-5 w-5 text-primary-600 flex-none" />
                        <span className="text-sm text-gray-900 truncate" title={f.name}>
                          {f.name}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {files.length > 0 && (
                <div>
                  {folders.length > 0 && !isSearching && (
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
                      Files
                    </div>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {files.map((f) => {
                      const isSelected = selected.has(f.id);
                      const alreadyInComposer = existingUrls?.includes(fileToPublicUrl(f));
                      return (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => toggle(f)}
                          className={`relative text-left rounded-lg border-2 overflow-hidden transition-colors ${
                            isSelected
                              ? 'border-primary-500 ring-2 ring-primary-200'
                              : 'border-gray-200 hover:border-gray-300'
                          } ${f.used ? 'opacity-90' : ''}`}
                        >
                          <div className="w-full aspect-square bg-gray-100 relative">
                            {/* Auth'd proxy — reliable regardless of the
                                user's Google browser session. Drive's own
                                thumbnailLink CDN needs a Google cookie and
                                often falls back to a generic placeholder. */}
                            <SmartPreviewImage
                              url={fileToPublicUrl(f)}
                              className="w-full h-full object-cover"
                              alt={f.name}
                            />
                            {f.used && (
                              <span
                                className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/95 text-white shadow"
                                title={
                                  f.usedAt
                                    ? `Used on ${new Date(f.usedAt).toLocaleDateString()}`
                                    : 'Used in a previous post'
                                }
                              >
                                Already used
                              </span>
                            )}
                            {isSelected && (
                              <span className="absolute top-1.5 right-1.5 rounded-full bg-primary-600 text-white p-0.5 shadow">
                                <CheckCircle2 className="h-4 w-4" />
                              </span>
                            )}
                            {alreadyInComposer && !isSelected && (
                              <span
                                className="absolute bottom-1.5 right-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-800/80 text-white"
                                title="Already in the current post draft"
                              >
                                In draft
                              </span>
                            )}
                          </div>
                          <div className="p-2">
                            <div className="text-xs text-gray-900 truncate" title={f.name}>
                              {f.name}
                            </div>
                            {f.modifiedTime && (
                              <div className="text-[10px] text-gray-500 mt-0.5">
                                {new Date(f.modifiedTime).toLocaleDateString()}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between gap-2">
          <div className="text-xs text-gray-500">
            {selected.size > 0
              ? `${selected.size} selected · make sure the files are set to "Anyone with link" on Drive so GMB can fetch them.`
              : 'Click images to select · files must be shared publicly on Drive for GMB to fetch them.'}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={selected.size === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
              Add {selected.size > 0 ? `${selected.size} ` : ''}image{selected.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Calendar;
