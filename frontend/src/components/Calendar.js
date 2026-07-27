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
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import businessProfileService from '../services/businessProfileService';
import calendarService from '../services/calendarService';

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
// user thinks about (each GMB location).
const flattenLocations = (profiles) => {
  if (!Array.isArray(profiles)) return [];
  const out = [];
  profiles.forEach((account) => {
    const accountId = account?.name?.split('/').pop();
    const accountLabel = account?.accountName || account?.displayName || 'Business';
    (account.locations || []).forEach((loc) => {
      const locationId = loc?.name?.split('/').pop();
      if (!accountId || !locationId) return;
      out.push({
        key: `${accountId}:${locationId}`,
        accountId,
        locationId,
        title: loc.locationName || loc.title || locationId,
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
  useEffect(() => {
    if (!isAuthenticated || isDisconnected) return;
    let cancelled = false;
    (async () => {
      try {
        const profiles = await businessProfileService.getAccounts();
        if (cancelled) return;
        const flat = flattenLocations(profiles);
        setLocations(flat);
        setSelectedLocationKeys(new Set(flat.map((l) => l.key))); // all on by default
      } catch (e) {
        // Non-fatal — calendar still works without location filter
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isDisconnected]);

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

  // Empty cell click → open the schedule modal with the clicked date as
  // the default. If there are no connected profiles, bounce to Connections.
  const openCreateForDate = (day) => {
    if (locations.length === 0) {
      navigate('/connections');
      return;
    }
    // Default the time to 9:00 AM local on the clicked day if that day is
    // in the future; otherwise 1 hour from now.
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
        <ScheduleModal
          defaultDate={scheduleModal.defaultDate}
          locations={locations}
          selectedLocationKeys={selectedLocationKeys}
          onClose={() => setScheduleModal(null)}
          onScheduled={handleScheduled}
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

// ── Schedule modal ─────────────────────────────────────────

// Converts a Date to a value compatible with <input type="datetime-local">
// (YYYY-MM-DDTHH:mm, local time, no timezone suffix).
const toLocalInputValue = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const ScheduleModal = ({ defaultDate, locations, selectedLocationKeys, onClose, onScheduled }) => {
  // Pre-pick the first sidebar-selected location; fall back to first available.
  const preselected =
    locations.find((l) => selectedLocationKeys.has(l.key)) || locations[0] || null;

  const [locationKey, setLocationKey] = useState(preselected?.key || '');
  const [content, setContent] = useState('');
  const [when, setWhen] = useState(() => toLocalInputValue(new Date(defaultDate)));
  const [postType, setPostType] = useState('UPDATE');
  const [mediaUrl, setMediaUrl] = useState('');
  const [ctaType, setCtaType] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!content.trim()) {
      setError('Content is required.');
      return;
    }
    if (!locationKey) {
      setError('Pick a business profile.');
      return;
    }
    const target = locations.find((l) => l.key === locationKey);
    if (!target) {
      setError('Business profile not found.');
      return;
    }
    const scheduledDate = new Date(when);
    if (Number.isNaN(scheduledDate.getTime())) {
      setError('Invalid date/time.');
      return;
    }
    if (scheduledDate.getTime() < Date.now() - 60_000) {
      setError('Scheduled time must be in the future.');
      return;
    }

    setSubmitting(true);
    try {
      await calendarService.schedule({
        content: content.trim(),
        media: mediaUrl.trim() ? [{ sourceUrl: mediaUrl.trim(), mediaFormat: 'PHOTO' }] : [],
        gmbAccountId: target.accountId,
        gmbLocationId: target.locationId,
        scheduledTime: scheduledDate,
        postType,
        callToAction:
          ctaType && ctaUrl.trim() ? { actionType: ctaType, url: ctaUrl.trim() } : null,
      });
      onScheduled?.();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to schedule');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="flex items-start justify-between p-5 border-b border-gray-200">
          <div>
            <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary-600" />
              Schedule a post
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              The publisher will POST this to Google Business Profile at the scheduled time.
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

        <div className="p-5 space-y-4">
          {locations.length === 0 && (
            <div className="p-3 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-900">
              No connected business profiles. Connect one first.
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Business profile</label>
            <select
              value={locationKey}
              onChange={(e) => setLocationKey(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-primary-500"
              disabled={locations.length === 0}
            >
              {locations.map((loc) => (
                <option key={loc.key} value={loc.key}>
                  {loc.title}
                  {loc.addressLine ? ` — ${loc.addressLine}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Scheduled time</label>
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Post type</label>
              <select
                value={postType}
                onChange={(e) => setPostType(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-primary-500"
              >
                <option value="UPDATE">Update</option>
                <option value="EVENT">Event</option>
                <option value="OFFER">Offer</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              placeholder="What do you want to post?"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-primary-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Image URL <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="url"
              value={mediaUrl}
              onChange={(e) => setMediaUrl(e.target.value)}
              placeholder="https://…"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:ring-primary-500"
            />
          </div>

          <details className="rounded-md border border-gray-200">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-700 select-none">
              Call to action (optional)
            </summary>
            <div className="p-3 grid grid-cols-2 gap-3 border-t border-gray-200">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Type</label>
                <select
                  value={ctaType}
                  onChange={(e) => setCtaType(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">None</option>
                  <option value="BOOK">Book</option>
                  <option value="ORDER">Order</option>
                  <option value="SHOP">Shop</option>
                  <option value="LEARN_MORE">Learn more</option>
                  <option value="SIGN_UP">Sign up</option>
                  <option value="CALL">Call</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">URL</label>
                <input
                  type="url"
                  value={ctaUrl}
                  onChange={(e) => setCtaUrl(e.target.value)}
                  placeholder="https://…"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
          </details>

          {error && (
            <div className="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
              {error}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || locations.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-60"
          >
            <Clock className="h-4 w-4" />
            {submitting ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default Calendar;
