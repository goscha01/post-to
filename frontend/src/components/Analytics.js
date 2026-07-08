import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  BarChart3,
  Users,
  MousePointerClick,
  TrendingUp,
  DollarSign,
  Clock,
  Target,
  Globe,
  Smartphone,
  Monitor,
  Tablet,
  RefreshCw,
  AlertCircle,
  Plus,
  Link2,
  X,
  Check,
} from 'lucide-react';
import analyticsService from '../services/analyticsService';

const DAY_RANGES = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
];

const fmtInt = (n) => {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString();
};

const fmtDuration = (seconds) => {
  const s = Number(seconds || 0);
  if (!Number.isFinite(s) || s <= 0) return '0s';
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
};

const fmtPercent = (rate) => {
  const v = Number(rate || 0);
  if (!Number.isFinite(v)) return '—';
  // GA4 returns rates as decimals (0.42 = 42%).
  return `${(v * 100).toFixed(1)}%`;
};

const fmtMoney = (n) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '$0';
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
};

const Analytics = () => {
  const { user } = useAuth();

  const [connectedProperties, setConnectedProperties] = useState([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);
  const [days, setDays] = useState(30);

  const [overview, setOverview] = useState(null);
  const [traffic, setTraffic] = useState([]);
  const [landing, setLanding] = useState([]);
  const [events, setEvents] = useState({ rows: [], highlighted: [] });
  const [campaigns, setCampaigns] = useState([]);
  const [devices, setDevices] = useState([]);
  const [geography, setGeography] = useState([]);

  const [loading, setLoading] = useState(true);
  const [loadingReports, setLoadingReports] = useState(false);
  const [error, setError] = useState('');
  const [needsPropertySelection, setNeedsPropertySelection] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedProperty = useMemo(
    () => connectedProperties.find(p => p.propertyId === selectedPropertyId) || null,
    [connectedProperties, selectedPropertyId]
  );

  const loadConnected = useCallback(async () => {
    setLoading(true);
    setError('');
    setNeedsReauth(false);
    try {
      const rows = await analyticsService.listConnectedProperties();
      setConnectedProperties(rows);
      if (rows.length > 0) {
        // Restore last selection from localStorage if it's still connected.
        const last = localStorage.getItem('gmb_analytics_property_id');
        const match = last && rows.find(r => r.propertyId === last);
        setSelectedPropertyId(match ? match.propertyId : rows[0].propertyId);
        setNeedsPropertySelection(false);
      } else {
        setSelectedPropertyId(null);
        setNeedsPropertySelection(true);
      }
    } catch (e) {
      const status = e.response?.status;
      if (status === 403 && e.response?.data?.needsReauth) {
        setNeedsReauth(true);
      }
      setError(e.response?.data?.error || e.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReports = useCallback(async (propertyId, rangeDays) => {
    if (!propertyId) return;
    setLoadingReports(true);
    setError('');
    try {
      const [o, t, l, e, c, d, g] = await Promise.all([
        analyticsService.getOverview(propertyId, rangeDays),
        analyticsService.getTraffic(propertyId, rangeDays),
        analyticsService.getLandingPages(propertyId, rangeDays),
        analyticsService.getEvents(propertyId, rangeDays),
        analyticsService.getCampaigns(propertyId, rangeDays),
        analyticsService.getDevices(propertyId, rangeDays),
        analyticsService.getGeography(propertyId, rangeDays),
      ]);
      setOverview(o.overview);
      setTraffic(t.traffic || []);
      setLanding(l.landingPages || []);
      setEvents(e.events || { rows: [], highlighted: [] });
      setCampaigns(c.campaigns || []);
      setDevices(d.devices || []);
      setGeography(g.geography || []);
    } catch (err) {
      const status = err.response?.status;
      if (status === 403 && err.response?.data?.needsReauth) {
        setNeedsReauth(true);
      }
      if (status === 400 && err.response?.data?.needsPropertySelection) {
        setNeedsPropertySelection(true);
      }
      setError(err.response?.data?.error || err.message || 'Failed to load analytics data');
    } finally {
      setLoadingReports(false);
    }
  }, []);

  useEffect(() => {
    loadConnected();
  }, [loadConnected]);

  useEffect(() => {
    if (selectedPropertyId) {
      localStorage.setItem('gmb_analytics_property_id', selectedPropertyId);
      loadReports(selectedPropertyId, days);
    }
  }, [selectedPropertyId, days, loadReports]);

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-primary-600" />
            Analytics
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Website performance from Google Analytics 4 — read-only.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {connectedProperties.length > 0 && (
            <PropertySelector
              properties={connectedProperties}
              value={selectedPropertyId}
              onChange={setSelectedPropertyId}
            />
          )}
          <DayRangeSelector value={days} onChange={setDays} />
          <button
            onClick={() => selectedPropertyId && loadReports(selectedPropertyId, days)}
            disabled={!selectedPropertyId || loadingReports}
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loadingReports ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
          >
            <Plus className="h-4 w-4" />
            {connectedProperties.length ? 'Add property' : 'Connect property'}
          </button>
        </div>
      </div>

      {needsReauth && (
        <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-md">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900">
                Analytics permission missing
              </p>
              <p className="text-sm text-amber-800 mt-1">
                Reconnecting Google Business Profile grants the Analytics scope <em>only if</em> the
                scope is enabled in your Google Cloud Console. If reconnecting didn't help, check:
              </p>
              <ol className="text-sm text-amber-800 mt-2 ml-4 list-decimal space-y-1">
                <li>
                  <strong>Google Cloud Console → APIs &amp; Services → OAuth consent screen → Scopes</strong>:
                  add <code className="text-xs px-1 py-0.5 bg-amber-100 rounded">.../auth/analytics.readonly</code>.
                </li>
                <li>
                  <strong>APIs &amp; Services → Enabled APIs</strong>: enable
                  <em> Google Analytics Admin API</em> and <em>Google Analytics Data API</em>.
                </li>
                <li>Then reconnect Google Business Profile again.</li>
              </ol>
              <p className="text-sm text-amber-800 mt-2">
                To see exactly which scopes your current token has, open{' '}
                <code className="text-xs px-1 py-0.5 bg-amber-100 rounded">/api/analytics/_diagnose</code> in a new tab.
              </p>
            </div>
          </div>
        </div>
      )}

      {error && !needsReauth && (
        <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : needsPropertySelection ? (
        <EmptyState onConnect={() => setPickerOpen(true)} />
      ) : (
        <>
          {selectedProperty && (
            <p className="text-xs text-gray-500 mb-4">
              Property: <span className="font-medium text-gray-700">{selectedProperty.displayName}</span>{' '}
              <span className="text-gray-400">({selectedProperty.propertyId})</span>
            </p>
          )}

          <OverviewCards overview={overview} loading={loadingReports} />

          {events.highlighted && events.highlighted.length > 0 && (
            <HighlightedEvents events={events.highlighted} />
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
            <Section title="Traffic Sources" subtitle="Source / medium / campaign">
              <TrafficTable rows={traffic} loading={loadingReports} />
            </Section>
            <Section title="Devices" subtitle="Mobile / desktop / tablet">
              <DeviceBars rows={devices} loading={loadingReports} />
            </Section>
          </div>

          <div className="mt-8">
            <Section title="Landing Pages" subtitle="Top entry pages">
              <LandingPagesTable rows={landing} loading={loadingReports} />
            </Section>
          </div>

          <div className="mt-8">
            <Section title="Campaigns" subtitle="utm_campaign performance">
              <CampaignsTable rows={campaigns} loading={loadingReports} />
            </Section>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
            <Section title="Events" subtitle="Custom & default events">
              <EventsTable rows={events.rows} loading={loadingReports} />
            </Section>
            <Section title="Geography" subtitle="Country / region / city">
              <GeographyTable rows={geography} loading={loadingReports} />
            </Section>
          </div>
        </>
      )}

      {pickerOpen && (
        <PropertyPickerModal
          user={user}
          onClose={() => setPickerOpen(false)}
          onConnected={async (row) => {
            setPickerOpen(false);
            await loadConnected();
            const propertyId = row?.metadata?.property_id;
            if (propertyId) setSelectedPropertyId(propertyId);
          }}
        />
      )}
    </div>
  );
};

// ---------- Sub-components ----------

const PropertySelector = ({ properties, value, onChange }) => (
  <div className="inline-flex items-center gap-2 bg-white border border-gray-300 rounded-md px-3 py-2">
    <Link2 className="h-4 w-4 text-gray-400" />
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      className="text-sm text-gray-700 bg-transparent border-0 focus:ring-0 focus:outline-none pr-6"
    >
      {properties.map(p => (
        <option key={p.propertyId} value={p.propertyId}>
          {p.displayName}
        </option>
      ))}
    </select>
  </div>
);

const DayRangeSelector = ({ value, onChange }) => (
  <div className="inline-flex bg-white border border-gray-300 rounded-md p-0.5">
    {DAY_RANGES.map(r => (
      <button
        key={r.value}
        onClick={() => onChange(r.value)}
        className={`px-3 py-1.5 text-sm font-medium rounded ${
          value === r.value
            ? 'bg-primary-600 text-white'
            : 'text-gray-700 hover:bg-gray-50'
        }`}
      >
        {r.label}
      </button>
    ))}
  </div>
);

const EmptyState = ({ onConnect }) => (
  <div className="text-center py-16 px-4 border-2 border-dashed border-gray-200 rounded-lg bg-white">
    <BarChart3 className="h-10 w-10 text-gray-400 mx-auto mb-3" />
    <h3 className="text-base font-medium text-gray-900">No GA4 property connected</h3>
    <p className="text-sm text-gray-500 mt-1 mb-4">
      Connect a Google Analytics 4 property to see website performance — sessions, conversions,
      landing pages, campaigns, and more.
    </p>
    <button
      onClick={onConnect}
      className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
    >
      <Plus className="h-4 w-4" />
      Connect GA4 property
    </button>
  </div>
);

const OverviewCards = ({ overview, loading }) => {
  const cards = [
    { key: 'users', label: 'Users', icon: Users, value: fmtInt(overview?.users) },
    { key: 'newUsers', label: 'New Users', icon: Users, value: fmtInt(overview?.newUsers) },
    { key: 'sessions', label: 'Sessions', icon: MousePointerClick, value: fmtInt(overview?.sessions) },
    { key: 'engagedSessions', label: 'Engaged Sessions', icon: TrendingUp, value: fmtInt(overview?.engagedSessions) },
    { key: 'engagementRate', label: 'Engagement Rate', icon: TrendingUp, value: fmtPercent(overview?.engagementRate) },
    { key: 'avgEngagement', label: 'Avg Engagement', icon: Clock, value: fmtDuration(overview?.averageEngagementTime) },
    { key: 'conversions', label: 'Conversions', icon: Target, value: fmtInt(overview?.conversions) },
    { key: 'revenue', label: 'Revenue', icon: DollarSign, value: fmtMoney(overview?.totalRevenue) },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(c => {
        const Icon = c.icon;
        return (
          <div key={c.key} className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
              <Icon className="h-3.5 w-3.5" />
              {c.label}
            </div>
            <div className="mt-2 text-2xl font-semibold text-gray-900">
              {loading ? <span className="text-gray-300">—</span> : c.value}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const HighlightedEvents = ({ events }) => (
  <div className="mt-6 bg-emerald-50 border border-emerald-200 rounded-lg p-4">
    <p className="text-xs font-medium text-emerald-900 uppercase tracking-wide mb-2">Key Events</p>
    <div className="flex flex-wrap gap-4">
      {events.map(e => (
        <div key={e.eventName}>
          <p className="text-xs text-emerald-700">{e.eventName}</p>
          <p className="text-xl font-semibold text-emerald-900">{fmtInt(e.eventCount)}</p>
        </div>
      ))}
    </div>
  </div>
);

const Section = ({ title, subtitle, children }) => (
  <div className="bg-white border border-gray-200 rounded-lg">
    <div className="px-4 py-3 border-b border-gray-100">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
    </div>
    <div className="p-0">{children}</div>
  </div>
);

const TableEmpty = () => (
  <div className="p-6 text-center text-sm text-gray-500">No data for this date range.</div>
);

const TableLoading = () => (
  <div className="p-6 text-center text-sm text-gray-400">Loading…</div>
);

const Th = ({ children, align = 'left' }) => (
  <th className={`px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide ${
    align === 'right' ? 'text-right' : 'text-left'
  }`}>
    {children}
  </th>
);

const Td = ({ children, align = 'left', className = '' }) => (
  <td className={`px-3 py-2 text-sm text-gray-700 whitespace-nowrap ${
    align === 'right' ? 'text-right' : 'text-left'
  } ${className}`}>
    {children}
  </td>
);

const TrafficTable = ({ rows, loading }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-100">
        <thead className="bg-gray-50">
          <tr>
            <Th>Source</Th>
            <Th>Medium</Th>
            <Th align="right">Sessions</Th>
            <Th align="right">Users</Th>
            <Th align="right">Conv.</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.slice(0, 25).map((r, i) => (
            <tr key={i}>
              <Td className="font-medium text-gray-900">{r.source}</Td>
              <Td>{r.medium}</Td>
              <Td align="right">{fmtInt(r.sessions)}</Td>
              <Td align="right">{fmtInt(r.users)}</Td>
              <Td align="right">{fmtInt(r.conversions)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const LandingPagesTable = ({ rows, loading }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-100">
        <thead className="bg-gray-50">
          <tr>
            <Th>Landing Page</Th>
            <Th align="right">Sessions</Th>
            <Th align="right">Engage %</Th>
            <Th align="right">Avg Time</Th>
            <Th align="right">Conv.</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.slice(0, 25).map((r, i) => (
            <tr key={i}>
              <Td className="font-mono text-xs text-gray-800 max-w-md truncate" align="left">
                <span title={r.landingPage}>{r.landingPage}</span>
              </Td>
              <Td align="right">{fmtInt(r.sessions)}</Td>
              <Td align="right">{fmtPercent(r.engagementRate)}</Td>
              <Td align="right">{fmtDuration(r.averageEngagementTime)}</Td>
              <Td align="right">{fmtInt(r.conversions)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const CampaignsTable = ({ rows, loading }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-gray-500">
        No named campaigns in this range. Tag traffic with{' '}
        <code className="text-xs px-1 py-0.5 bg-gray-100 rounded">utm_campaign</code> to see it here.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-100">
        <thead className="bg-gray-50">
          <tr>
            <Th>Campaign</Th>
            <Th>Source / Medium</Th>
            <Th align="right">Sessions</Th>
            <Th align="right">Users</Th>
            <Th align="right">Conv.</Th>
            <Th align="right">Revenue</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.slice(0, 25).map((r, i) => (
            <tr key={i}>
              <Td className="font-medium text-gray-900">{r.campaign}</Td>
              <Td className="text-xs text-gray-500">{r.source} / {r.medium}</Td>
              <Td align="right">{fmtInt(r.sessions)}</Td>
              <Td align="right">{fmtInt(r.users)}</Td>
              <Td align="right">{fmtInt(r.conversions)}</Td>
              <Td align="right">{fmtMoney(r.revenue)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const DeviceBars = ({ rows, loading }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  const max = Math.max(...rows.map(r => Number(r.sessions || 0)), 1);
  const iconFor = (d) => {
    if (d === 'mobile') return Smartphone;
    if (d === 'tablet') return Tablet;
    return Monitor;
  };
  return (
    <div className="p-4 space-y-3">
      {rows.map((r) => {
        const Icon = iconFor(r.device);
        const pct = Math.round((Number(r.sessions || 0) / max) * 100);
        return (
          <div key={r.device}>
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 text-gray-700">
                <Icon className="h-4 w-4 text-gray-400" />
                <span className="capitalize">{r.device}</span>
              </div>
              <div className="text-gray-500 text-xs">
                {fmtInt(r.sessions)} sess · {fmtPercent(r.conversionRate)} conv rate
              </div>
            </div>
            <div className="mt-1 h-2 bg-gray-100 rounded">
              <div
                className="h-2 bg-primary-500 rounded"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};

const EventsTable = ({ rows, loading }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  return (
    <div className="overflow-x-auto max-h-96 overflow-y-auto">
      <table className="min-w-full divide-y divide-gray-100">
        <thead className="bg-gray-50 sticky top-0">
          <tr>
            <Th>Event</Th>
            <Th align="right">Count</Th>
            <Th align="right">Users</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.slice(0, 40).map((r, i) => (
            <tr key={i} className={r.highlighted ? 'bg-emerald-50' : ''}>
              <Td className="font-mono text-xs">
                {r.eventName}
                {r.highlighted && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded uppercase font-semibold">
                    key
                  </span>
                )}
              </Td>
              <Td align="right">{fmtInt(r.eventCount)}</Td>
              <Td align="right">{fmtInt(r.users)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const GeographyTable = ({ rows, loading }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  return (
    <div className="overflow-x-auto max-h-96 overflow-y-auto">
      <table className="min-w-full divide-y divide-gray-100">
        <thead className="bg-gray-50 sticky top-0">
          <tr>
            <Th>Country</Th>
            <Th>Region</Th>
            <Th>City</Th>
            <Th align="right">Sessions</Th>
            <Th align="right">Users</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.slice(0, 50).map((r, i) => (
            <tr key={i}>
              <Td className="font-medium text-gray-900 flex items-center gap-1">
                <Globe className="h-3 w-3 text-gray-400" />
                {r.country}
              </Td>
              <Td>{r.region}</Td>
              <Td>{r.city}</Td>
              <Td align="right">{fmtInt(r.sessions)}</Td>
              <Td align="right">{fmtInt(r.users)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ---------- Property picker modal ----------

const PropertyPickerModal = ({ onClose, onConnected }) => {
  const { loginForBusiness } = useAuth();
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [needsReauth, setNeedsReauth] = useState(false);
  const [selecting, setSelecting] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr('');
      setNeedsReauth(false);
      try {
        const rows = await analyticsService.listAvailableProperties();
        setProperties(rows);
      } catch (e) {
        const status = e.response?.status;
        if (status === 403 && e.response?.data?.needsReauth) {
          setNeedsReauth(true);
        } else if (status === 403 && e.response?.data?.needsBusinessAuth) {
          setNeedsReauth(true);
        }
        setErr(e.response?.data?.error || e.message || 'Failed to list properties');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSelect = async (prop) => {
    setSelecting(prop.propertyId);
    setErr('');
    try {
      const row = await analyticsService.selectProperty({
        propertyId: prop.propertyId,
        displayName: prop.displayName,
        accountId: prop.accountId,
      });
      onConnected(row);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed to save property');
      setSelecting(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Connect GA4 property</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-gray-500">Loading properties…</p>
          ) : needsReauth ? (
            <div>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800 mb-4 space-y-2">
                <p className="font-medium">Your Google connection doesn't have Analytics permission.</p>
                <p>
                  Before clicking reconnect, make sure the following are set in your{' '}
                  <strong>Google Cloud Console</strong>:
                </p>
                <ol className="ml-4 list-decimal space-y-1">
                  <li>
                    <strong>OAuth consent screen → Scopes</strong>: add
                    {' '}<code className="text-xs px-1 py-0.5 bg-amber-100 rounded">.../auth/analytics.readonly</code>
                  </li>
                  <li>
                    <strong>Enabled APIs</strong>: enable both
                    <em> Google Analytics Admin API</em> and <em>Google Analytics Data API</em>
                  </li>
                </ol>
                <p className="text-xs">
                  Without these two, reconnecting silently drops the analytics scope on Google's side —
                  you'll come back with the same permissions you had before.
                </p>
              </div>
              <button
                onClick={() => loginForBusiness()}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700"
              >
                Reconnect Google
              </button>
            </div>
          ) : properties.length === 0 ? (
            <div>
              <p className="text-sm text-gray-500 mb-4">
                No GA4 properties found on your Google account.
              </p>
              {err && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">{err}</div>
              )}
            </div>
          ) : (
            <div>
              <p className="text-sm text-gray-500 mb-4">
                Pick a property to connect. You can connect multiple.
              </p>
              {err && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800 mb-3">{err}</div>
              )}
              <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md">
                {properties.map(p => (
                  <li key={p.propertyId} className="p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{p.displayName}</p>
                      <p className="text-xs text-gray-500">
                        Property {p.propertyId}
                        {p.accountName && <> · Account: {p.accountName}</>}
                      </p>
                    </div>
                    <button
                      onClick={() => handleSelect(p)}
                      disabled={!!selecting}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-700 disabled:opacity-50"
                    >
                      {selecting === p.propertyId ? (
                        'Saving…'
                      ) : (
                        <>
                          <Check className="h-3 w-3" />
                          Connect
                        </>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Analytics;
