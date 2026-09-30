import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  BarChart3,
  Users,
  UserPlus,
  UserCheck,
  MousePointerClick,
  TrendingUp,
  CreditCard,
  Globe,
  Smartphone,
  Monitor,
  Tablet,
  RefreshCw,
  AlertCircle,
  Plus,
  Link2,
  Download,
  Eye,
  MousePointer2,
  Apple,
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
  const [days, setDays] = useState(7);

  const [overview, setOverview] = useState(null);
  const [traffic, setTraffic] = useState([]);
  const [landing, setLanding] = useState([]);
  const [events, setEvents] = useState({ rows: [], highlighted: [] });
  const [campaigns, setCampaigns] = useState([]);
  const [devices, setDevices] = useState([]);
  const [geography, setGeography] = useState([]);
  const [inAppFunnel, setInAppFunnel] = useState(null);
  // Distinct users per screen (GA4 built-in screenName dimension). Powers the
  // screen-level sub-steps under each in-app funnel step (e.g. onboarding
  // screen drop-off). Kept as an object { name → users } for O(1) lookup.
  const [screensByName, setScreensByName] = useState(null);
  // plan_selected breakdown by plan_id + billing_period. Shown as sub-steps
  // under the Selected a plan funnel row. `null` before load, `{ rows, error }`
  // after (error is set if custom dims aren't registered in GA4 Admin).
  const [planBreakdown, setPlanBreakdown] = useState(null);
  // ASC (App Store Connect — iOS top-of-funnel) is fetched independently of
  // the GA4 property. `null` before load, `{ connected: false }` when the
  // user has no ASC connection, `{ connected: true, totals, connectionName }`
  // otherwise. Kept separate so a missing ASC connection doesn't block GA4.
  const [ascState, setAscState] = useState(null);
  // Ad attribution rows from ASC (source × campaign × PPV × installs).
  // Same lifecycle as ascState — fetched alongside install funnel.
  const [adAttribution, setAdAttribution] = useState(null);

  const [loading, setLoading] = useState(true);
  const [loadingReports, setLoadingReports] = useState(false);
  const [error, setError] = useState('');
  const [needsPropertySelection, setNeedsPropertySelection] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [propertyPermission, setPropertyPermission] = useState(null); // { propertyId, triedAccounts }
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedProperty = useMemo(
    () => connectedProperties.find(p => p.propertyId === selectedPropertyId) || null,
    [connectedProperties, selectedPropertyId]
  );

  // Client-side JSON export of every table + overview currently rendered.
  // Filename embeds property + range + date so multiple exports don't collide.
  const handleExportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      property: selectedProperty
        ? {
            propertyId: selectedProperty.propertyId,
            displayName: selectedProperty.displayName,
            accountId: selectedProperty.accountId,
          }
        : { propertyId: selectedPropertyId },
      rangeDays: days,
      overview,
      appStore: ascState?.connected ? ascState.totals : null,
      inAppFunnel: inAppFunnel?.funnel || null,
      trafficSources: traffic,
      landingPages: landing,
      campaigns,
      devices,
      events: events.rows,
      highlightedEvents: events.highlighted,
      geography,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `analytics-${selectedPropertyId || 'unknown'}-${days}d-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const canExport = !!overview && !loadingReports;

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
    setPropertyPermission(null);
    // The in-app funnel hits GA4's v1alpha runFunnelReport endpoint, which can
    // fail on properties that don't yet have any funnel-eligible data. Fetched
    // with .catch so a funnel failure doesn't blank out the whole dashboard.
    try {
      const [o, t, l, e, c, d, g, f, sv, pb] = await Promise.all([
        analyticsService.getOverview(propertyId, rangeDays),
        analyticsService.getTraffic(propertyId, rangeDays),
        analyticsService.getLandingPages(propertyId, rangeDays),
        analyticsService.getEvents(propertyId, rangeDays),
        analyticsService.getCampaigns(propertyId, rangeDays),
        analyticsService.getDevices(propertyId, rangeDays),
        analyticsService.getGeography(propertyId, rangeDays),
        analyticsService.getInAppFunnel(propertyId, rangeDays).catch(err => {
          console.warn('[Analytics] in-app funnel failed:', err?.response?.data || err?.message);
          return null;
        }),
        analyticsService.getScreenViews(propertyId, rangeDays).catch(err => {
          console.warn('[Analytics] screen views failed:', err?.response?.data || err?.message);
          return null;
        }),
        analyticsService.getPlanBreakdown(propertyId, rangeDays).catch(err => {
          console.warn('[Analytics] plan breakdown failed:', err?.response?.data || err?.message);
          return null;
        }),
      ]);
      setOverview(o.overview);
      setTraffic(t.traffic || []);
      setLanding(l.landingPages || []);
      setEvents(e.events || { rows: [], highlighted: [] });
      setCampaigns(c.campaigns || []);
      setDevices(d.devices || []);
      setGeography(g.geography || []);
      setInAppFunnel(f?.inAppFunnel || null);
      // Index screens by name for O(1) sub-step lookups in FunnelSection.
      const screenMap = {};
      (sv?.screenViews?.screens || []).forEach(s => { screenMap[s.screenName] = s.users; });
      setScreensByName(screenMap);
      setPlanBreakdown(pb?.planBreakdown || null);
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data || {};
      if (status === 403 && data.needsPropertyPermission) {
        setPropertyPermission({
          propertyId: data.propertyId || propertyId,
          triedAccounts: data.triedAccounts || [],
        });
      } else if (status === 403 && data.needsReauth) {
        setNeedsReauth(true);
      }
      if (status === 400 && data.needsPropertySelection) {
        setNeedsPropertySelection(true);
      }
      setError(data.error || err.message || 'Failed to load analytics data');
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

  // ASC (App Store Connect) top-of-funnel. Fires on mount + whenever `days`
  // changes. Independent of GA4 — a user can have GA4 but no ASC (or vice
  // versa) and the page still renders whichever section has data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const connections = await analyticsService.listAscConnections();
        if (cancelled) return;
        if (!connections || connections.length === 0) {
          setAscState({ connected: false });
          return;
        }
        // Use the first connection. Multi-app users can pick via the App Store
        // page for now — a picker here is a follow-up if it comes up.
        const conn = connections[0];
        // Fetch install-funnel totals + ad-attribution in parallel — same
        // connection, same date range, independent Apple reports.
        const [funnel, attribution] = await Promise.all([
          analyticsService.getAscInstallFunnel(conn.connectionId, days),
          analyticsService.getAscAdAttribution(conn.connectionId, days).catch(err => {
            console.warn('[Analytics] ASC ad attribution failed:', err?.response?.data || err?.message);
            return null;
          }),
        ]);
        if (cancelled) return;
        setAscState({
          connected: true,
          connectionName: conn.displayName || conn.appBundleId || conn.connectionId,
          totals: funnel?.totals || null,
          days: funnel?.days || days,
        });
        setAdAttribution(attribution);
      } catch (err) {
        if (cancelled) return;
        console.warn('[Analytics] ASC funnel failed:', err?.response?.data || err?.message);
        setAscState({ connected: false, error: err?.response?.data?.error || err?.message });
        setAdAttribution(null);
      }
    })();
    return () => { cancelled = true; };
  }, [days]);

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
            onClick={handleExportJson}
            disabled={!canExport}
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
            title="Download all tables as JSON"
          >
            <Download className="h-4 w-4" />
            JSON
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

      {propertyPermission && (
        <PropertyPermissionBanner
          propertyId={propertyPermission.propertyId}
          triedAccounts={propertyPermission.triedAccounts}
          onConnectAnother={() => setPickerOpen(true)}
        />
      )}

      {error && !needsReauth && !propertyPermission && (
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
              {selectedProperty.ownerEmail && (
                <> · <span className="text-gray-500">owned by {selectedProperty.ownerEmail}</span></>
              )}
            </p>
          )}

          <OverviewCards overview={overview} loading={loadingReports} />

          <AppStoreSection ascState={ascState} />

          <AdAttributionSection attribution={adAttribution} />

          <FunnelSection
            inAppFunnel={inAppFunnel}
            screensByName={screensByName}
            planBreakdown={planBreakdown}
            loading={loadingReports}
          />

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
          {p.ownerEmail ? ` — ${p.ownerEmail}` : ''}
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

// Shown when Google's Data API returns 403 "insufficient permissions for this
// property" on EVERY connected Google account. Two paths forward:
//   1. Add the connected Google account as a Viewer in GA4 Admin.
//   2. Connect a different Google account that IS a Viewer on the property.
const PropertyPermissionBanner = ({ propertyId, triedAccounts, onConnectAnother }) => {
  const accessMgmtUrl = propertyId
    ? `https://analytics.google.com/analytics/web/#/a/p${propertyId}/admin/suiteuserlist`
    : 'https://analytics.google.com/analytics/web/#/admin';
  return (
    <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-md">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-medium text-amber-900">
            No access to GA4 property {propertyId}
          </p>
          <p className="text-sm text-amber-800 mt-1">
            Google Analytics rejected the report request with{' '}
            <em>"User does not have sufficient permissions for this property."</em>{' '}
            {triedAccounts && triedAccounts.length > 0 ? (
              <>
                Tried:{' '}
                <span className="font-mono text-xs bg-amber-100 px-1 py-0.5 rounded">
                  {triedAccounts.join(', ')}
                </span>
                . None of them are a GA4 Viewer on this property.
              </>
            ) : (
              <>The connected Google account is not a GA4 Viewer on this property.</>
            )}
          </p>
          <p className="text-sm text-amber-800 mt-2 font-medium">Two ways to fix:</p>
          <ol className="text-sm text-amber-800 mt-1 ml-4 list-decimal space-y-1">
            <li>
              In{' '}
              <a
                href={accessMgmtUrl}
                target="_blank"
                rel="noreferrer"
                className="underline font-medium hover:text-amber-900"
              >
                GA4 Admin → Property Access Management
              </a>
              , add the connected Google account as at least a <strong>Viewer</strong>.
              Then reload this page.
            </li>
            <li>
              Or connect a different Google account that already has Viewer access:
              <button
                onClick={onConnectAnother}
                className="ml-2 inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-700"
              >
                <Plus className="h-3 w-3" />
                Connect another
              </button>
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
};

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
    { key: 'newUsers', label: 'New Users', icon: UserPlus, value: fmtInt(overview?.newUsers) },
    { key: 'sessions', label: 'Sessions', icon: MousePointerClick, value: fmtInt(overview?.sessions) },
    { key: 'engagedSessions', label: 'Engaged Sessions', icon: TrendingUp, value: fmtInt(overview?.engagedSessions) },
    // Free / paid split. Paid = distinct users who fired `subscription_active`
    // or `purchase` in-period (ProofPix's paid-user signals — see backend
    // PAID_USER_EVENTS). Free = total − paid.
    { key: 'freeUsers', label: 'Free Users', icon: Users, value: fmtInt(overview?.freeUsers) },
    { key: 'paidUsers', label: 'Paid Users', icon: UserCheck, value: fmtInt(overview?.paidUsers) },
    // Two funnel conversions.
    //   Lead → User: signup rate = account_created / users
    //   User → Paid: paid conversion = purchase / account_created
    { key: 'leadToUser', label: 'Lead → User', icon: UserPlus, value: fmtPercent(overview?.leadToUserRate) },
    { key: 'userToPaid', label: 'User → Paid', icon: CreditCard, value: fmtPercent(overview?.userToPaidRate) },
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

// App Store Connect top-of-funnel (iOS only). Impressions → PPVs → Installs
// pulled from Apple Analytics + Sales & Trends via
// backend/src/services/ascAnalyticsService.js.
//
// States:
//   - ascState = null                        → still loading (skip render)
//   - ascState.connected = false             → "Connect App Store" placeholder
//   - ascState.connected = true, totals=null → connection exists but Apple
//                                              hasn't published data yet
//   - ascState.connected = true, totals set  → render the 3 tiles
const AppStoreSection = ({ ascState }) => {
  if (!ascState) return null;
  const cardWrap = 'bg-white border border-gray-200 rounded-lg p-4';
  if (!ascState.connected) {
    return (
      <div className="mt-6">
        <Section
          title="App Store (iOS)"
          subtitle="Top of funnel — impressions → page visitors → downloads"
        >
          <div className="p-6 text-sm text-gray-500 flex items-start gap-3">
            <Apple className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
            <div>
              Connect App Store Connect to see how many people saw your listing,
              visited the page, and downloaded the app.
              {ascState.error && (
                <div className="mt-1 text-xs text-red-500">{ascState.error}</div>
              )}
            </div>
          </div>
        </Section>
      </div>
    );
  }
  const t = ascState.totals || { impressions: 0, productPageViews: 0, installs: 0, conversionRate: null };
  const cards = [
    { key: 'impressions', label: 'Impressions',        icon: Eye,           value: fmtInt(t.impressions),
      hint: 'App Store listing shown in search or browse' },
    { key: 'ppv',         label: 'Store Page Visitors', icon: MousePointer2, value: fmtInt(t.productPageViews),
      hint: 'Users who tapped into the listing page' },
    { key: 'installs',    label: 'Downloads',           icon: Download,      value: fmtInt(t.installs),
      hint: 'First-time installs (Sales & Trends)' },
  ];
  return (
    <div className="mt-6">
      <Section
        title="App Store (iOS)"
        subtitle={
          <>
            Top of funnel — impressions → page visitors → downloads ·{' '}
            <span className="text-gray-400">
              from {ascState.connectionName} · Android not tracked (Play Console not integrated)
            </span>
          </>
        }
      >
        <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          {cards.map(c => {
            const Icon = c.icon;
            return (
              <div key={c.key} className={cardWrap} title={c.hint}>
                <div className="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
                  <Icon className="h-3.5 w-3.5" />
                  {c.label}
                </div>
                <div className="mt-2 text-2xl font-semibold text-gray-900">{c.value}</div>
              </div>
            );
          })}
        </div>
        {t.conversionRate !== null && t.conversionRate !== undefined && t.conversionRate <= 1 && (
          <div className="px-4 pb-4 text-xs text-gray-500">
            Store conversion rate (installs / page visitors, attributable days only):{' '}
            <span className="font-medium text-gray-700">{fmtPercent(t.conversionRate)}</span>
          </div>
        )}
        {t.conversionRate > 1 && (
          <div className="px-4 pb-4 text-xs text-gray-500">
            Store conversion rate hidden: installs ({fmtInt(t.installs)}) exceed page visitors ({fmtInt(t.productPageViews)}) —
            downloads include restores and direct-URL installs that bypass the listing page.
          </div>
        )}
      </Section>
    </div>
  );
};

// Ad Attribution — pairs paid campaigns with the actual installs they drove.
// Rows come pre-sorted with paid campaigns first (isPaid=true), then organic.
// Renders two tables: "Paid" (campaign-tagged) and "Organic" (no campaign)
// so ad ROI is instantly readable without hunting through organic rows.
const AdAttributionSection = ({ attribution }) => {
  if (!attribution) return null;
  const rows = attribution.rows || [];
  if (rows.length === 0) return null;
  const paid = rows.filter(r => r.isPaid);
  const organic = rows.filter(r => !r.isPaid);
  const paidT = attribution.paidTotals || { productPageViews: 0, installs: 0 };
  const paidConvRate = paidT.productPageViews > 0
    ? paidT.installs / paidT.productPageViews
    : null;
  return (
    <div className="mt-6">
      <Section
        title="Ad Attribution (iOS)"
        subtitle={
          <>
            Which App Store sources drove installs · paid campaigns highlighted ·{' '}
            <span className="text-gray-400">
              Meta / Google web ads must include Apple attribution params
              (<code className="text-[10px] px-1 bg-gray-100 rounded">pt</code>,
              {' '}<code className="text-[10px] px-1 bg-gray-100 rounded">ct</code>) to appear here with a campaign name
            </span>
          </>
        }
      >
        {paid.length > 0 && (
          <div className="p-4">
            <div className="flex items-center justify-between text-xs font-medium text-gray-600 uppercase tracking-wide mb-2">
              <span>Paid Campaigns</span>
              <span className="normal-case text-gray-500">
                {fmtInt(paidT.installs)} installs from {fmtInt(paidT.productPageViews)} PPVs
                {paidConvRate !== null && paidConvRate <= 1 && (
                  <> · <span className="font-semibold text-gray-700">{fmtPercent(paidConvRate)} conv</span></>
                )}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-gray-50">
                  <tr>
                    <Th>Source</Th>
                    <Th>Campaign</Th>
                    <Th align="right">Impressions</Th>
                    <Th align="right">Page visitors</Th>
                    <Th align="right">Installs</Th>
                    <Th align="right">Conv rate</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {paid.slice(0, 25).map((r, i) => (
                    <tr key={i} className="bg-emerald-50/40">
                      <Td className="font-medium text-gray-900">{r.sourceType}</Td>
                      <Td className="font-mono text-xs">{r.campaign}</Td>
                      <Td align="right">{fmtInt(r.impressions)}</Td>
                      <Td align="right">{fmtInt(r.productPageViews)}</Td>
                      <Td align="right" className="font-semibold text-emerald-700">{fmtInt(r.installs)}</Td>
                      <Td align="right">
                        {r.conversionRate !== null && r.conversionRate <= 1
                          ? fmtPercent(r.conversionRate)
                          : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {organic.length > 0 && (
          <div className="p-4 border-t border-gray-100">
            <div className="text-xs font-medium text-gray-600 uppercase tracking-wide mb-2">
              Organic Sources
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-gray-50">
                  <tr>
                    <Th>Source</Th>
                    <Th align="right">Impressions</Th>
                    <Th align="right">Page visitors</Th>
                    <Th align="right">Installs</Th>
                    <Th align="right">Conv rate</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {organic.slice(0, 25).map((r, i) => (
                    <tr key={i}>
                      <Td className="font-medium text-gray-900">{r.sourceType}</Td>
                      <Td align="right">{fmtInt(r.impressions)}</Td>
                      <Td align="right">{fmtInt(r.productPageViews)}</Td>
                      <Td align="right">{fmtInt(r.installs)}</Td>
                      <Td align="right">
                        {r.conversionRate !== null && r.conversionRate <= 1
                          ? fmtPercent(r.conversionRate)
                          : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {paid.length === 0 && (
          <div className="px-4 pb-3 text-xs text-gray-500">
            No campaign-tagged installs in this window. If you're running ads,
            check that ad landing URLs include Apple's
            {' '}<code className="text-[10px] px-1 bg-gray-100 rounded">pt</code> and
            {' '}<code className="text-[10px] px-1 bg-gray-100 rounded">ct</code> parameters
            (or use Apple Search Ads, which auto-tags).
          </div>
        )}
      </Section>
    </div>
  );
};

// Sub-step definitions — map each funnel step key to the app screens that
// represent it. Sub-steps use GA4 screenName distinct-user counts (unordered,
// see FunnelSection comment). Kept front-end-side because it's a UI concern
// (backend just serves raw screen counts).
// Screens that map to each parent funnel step. Verified against the actual
// screen_view events GA4 receives from ProofPix (checked 2026-09-30):
//   - Current build collapses the whole onboarding flow (welcome + user info +
//     permissions) into a single FirstLoadScreen. The separate
//     onboarding_welcome / onboarding_user_info / onboarding_permissions
//     screens exist in App.js's SCREEN_NAME_MAP but never fire — that flow
//     was refactored out. For screen-level onboarding drop-off, ProofPix
//     would need to reinstate the separate screens or add logScreenView
//     calls at each in-screen step.
//   - `first_load` (30 users) > "Onboarding done" (23 raw) shows there IS
//     drop-off within onboarding — 7 users bounce from the load screen
//     before completing.
const FUNNEL_SUBSTEPS = {
  onboarding_done: [
    { screenName: 'first_load', label: 'First load (onboarding)' },
  ],
  paywall: [
    { screenName: 'paywall', label: 'Paywall shown' },
  ],
};

// Renders the in-app funnel from getInAppFunnel. Prefers GA4's v1alpha
// runFunnelReport (real ordered drop-off). When that endpoint fails, the
// backend falls back to per-step distinct-user counts via v1beta — same
// shape, but the funnel is "approximate" (a user could skip a step and
// still be counted at a later one). `inAppFunnel.source` tells us which.
const FunnelSection = ({ inAppFunnel, screensByName, planBreakdown, loading }) => {
  const funnel = inAppFunnel?.funnel || null;
  const source = inAppFunnel?.source;
  const fallbackReason = inAppFunnel?.fallbackReason;
  const subtitle = source === 'v1beta_fallback' ? (
    <>
      <span className="text-amber-600">Approximate (fallback)</span> — GA4 runFunnelReport unavailable:{' '}
      <span className="font-mono">{fallbackReason || 'error'}</span>. Numbers are per-step distinct users, not strict sequential drop-off.
    </>
  ) : (
    'Ordered — each step requires the previous. Real drop-off via GA4 runFunnelReport.'
  );
  if (loading) {
    return (
      <div className="mt-6">
        <Section title="In-App Funnel (all platforms)" subtitle="Ordered — each step requires the previous. Real drop-off via GA4 runFunnelReport.">
          <TableLoading />
        </Section>
      </div>
    );
  }
  if (!funnel || funnel.length === 0) {
    return (
      <div className="mt-6">
        <Section title="In-App Funnel (all platforms)" subtitle="Ordered — each step requires the previous. Real drop-off via GA4 runFunnelReport.">
          <TableEmpty />
        </Section>
      </div>
    );
  }
  const topUsers = Number(funnel[0]?.users || 0);
  return (
    <div className="mt-6">
      <Section title="In-App Funnel (all platforms)" subtitle={subtitle}>
        <div className="p-4 space-y-3">
          {funnel.map((stage, i) => {
            const users = Number(stage.users || 0);
            const prevUsers = i === 0 ? users : Number(funnel[i - 1]?.users || 0);
            const pctOfLead = topUsers > 0 ? users / topUsers : 0;
            // Drop-off from the previous stage. Skipped on stage 0 (nothing to
            // drop from). Clamped ≥ 0 so a bump in a later stage — possible
            // when a returning paid user fires subscription_active without a
            // fresh first_photo_taken in the same window — shows 0% not −N%.
            const dropOff = i === 0 ? 0 : Math.max(0, prevUsers > 0 ? 1 - users / prevUsers : 0);
            // Give every bar at least a sliver of width so zero-stages are
            // visible in the chart (otherwise they collapse to nothing).
            const barPct = Math.max(pctOfLead * 100, 0.5);
            return (
              <div key={stage.key}>
                <div className="flex items-center justify-between text-sm gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-gray-800 font-medium">{stage.label}</span>
                    {stage.event && (
                      <span
                        className="text-xs text-gray-400 font-mono truncate"
                        title={stage.event}
                      >
                        · {stage.event}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs flex-shrink-0">
                    <span className="font-semibold text-gray-900 tabular-nums">
                      {fmtInt(users)}
                    </span>
                    {/* Raw per-event distinct users (independent of funnel
                        order). When it differs materially from the sequential
                        funnel count, the event is firing but not in order
                        (e.g. paywall shown before first_photo_taken, so those
                        users are excluded from the sequential count). */}
                    {stage.rawUsers != null && stage.rawUsers !== users && (
                      <span
                        className="text-gray-400 tabular-nums"
                        title="Users who fired this event in the period, ignoring funnel order. Difference vs. sequential means users hit the event out of the funnel sequence."
                      >
                        (raw {fmtInt(stage.rawUsers)})
                      </span>
                    )}
                    <span className="text-gray-500 tabular-nums">
                      {fmtPercent(pctOfLead)} of leads
                    </span>
                    {i > 0 && (
                      <span
                        className={`tabular-nums ${dropOff > 0 ? 'text-red-500' : 'text-gray-400'}`}
                        title={`Drop-off from ${funnel[i - 1].label}`}
                      >
                        ↓ {fmtPercent(dropOff)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-1 h-2 bg-gray-100 rounded">
                  <div
                    className="h-2 bg-primary-500 rounded transition-all"
                    style={{ width: `${barPct}%` }}
                  />
                </div>
                {/* Screen-level sub-steps for steps that have them mapped
                    (e.g. onboarding has 4 screens). Renders indented under
                    the parent step with its own drop-off percentages. */}
                <FunnelSubSteps
                  stepKey={stage.key}
                  screensByName={screensByName}
                  topUsers={topUsers}
                />
                {/* Plan breakdown under the "Selected a plan" step —
                    which plan (starter/pro/business) and which cadence
                    (monthly/annual/seat) users are picking. */}
                {stage.key === 'plan_selected' && (
                  <PlanBreakdownSubSteps planBreakdown={planBreakdown} />
                )}
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
};

// Sub-steps for a single parent funnel step. Renders all mapped screens
// (even at 0) so a broken mapping is visible instead of silently hidden.
// When every mapped screen is missing from the data, prints a debug line
// showing the top-N actual screen names GA4 knows about — makes it easy
// to spot when Firebase-auto-generated screen names differ from the
// snake_case names we expected.
const FunnelSubSteps = ({ stepKey, screensByName, topUsers }) => {
  const subs = FUNNEL_SUBSTEPS[stepKey];
  if (!subs || !screensByName) return null;
  const rows = subs.map(s => ({
    ...s,
    users: screensByName[s.screenName] ?? 0,
    knownInData: screensByName[s.screenName] !== undefined,
  }));
  const noneKnown = rows.every(r => !r.knownInData);
  return (
    <div className="mt-2 ml-4 pl-3 border-l-2 border-gray-100 space-y-1.5">
      {rows.map((r, i) => {
        const prev = i === 0 ? r.users : rows[i - 1].users;
        const dropOff = i === 0 ? 0 : Math.max(0, prev > 0 ? 1 - r.users / prev : 0);
        const pctOfLead = topUsers > 0 ? r.users / topUsers : 0;
        return (
          <div key={r.screenName}>
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className={r.knownInData ? 'text-gray-600' : 'text-gray-400'}>
                  ↳ {r.label}
                </span>
                <span className="text-[10px] text-gray-400 font-mono truncate">{r.screenName}</span>
                {!r.knownInData && (
                  <span className="text-[10px] text-amber-600" title="This screen name doesn't appear in GA4's data">
                    (not in data)
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="tabular-nums text-gray-800">{fmtInt(r.users)}</span>
                <span className="tabular-nums text-gray-400">{fmtPercent(pctOfLead)}</span>
                {i > 0 && (
                  <span
                    className={`tabular-nums text-[11px] ${dropOff > 0 ? 'text-red-400' : 'text-gray-300'}`}
                  >
                    ↓ {fmtPercent(dropOff)}
                  </span>
                )}
              </div>
            </div>
            <div className="mt-0.5 h-1 bg-gray-50 rounded">
              <div
                className="h-1 bg-primary-300 rounded"
                style={{ width: `${Math.max(pctOfLead * 100, 0.5)}%` }}
              />
            </div>
          </div>
        );
      })}
      {/* Show top screens whenever ANY expected screen is missing (not just
          when all are missing). Reveals the actual GA4 screen names so we
          can update the FUNNEL_SUBSTEPS mapping. */}
      {rows.some(r => !r.knownInData) && (
        <div className="mt-2 text-[11px] text-gray-500">
          <span className="text-amber-700">Screens missing:</span>{' '}
          {rows.filter(r => !r.knownInData).map(r => r.screenName).join(', ')}
          <br />
          <span className="text-gray-600">All screens in GA4 (top 15):</span>{' '}
          {topScreenNames(screensByName, 15).join(', ') || '(no screens tracked)'}
        </div>
      )}
    </div>
  );
};

// Returns the top-N screen names from screensByName, sorted by user count.
function topScreenNames(screensByName, n) {
  return Object.entries(screensByName || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, users]) => `${name} (${users})`);
}

// Plan breakdown under the "Selected a plan" funnel row. Shows one line per
// (plan, billing_period) combination with distinct users + event count.
// Renders a "register custom dims in GA4 Admin" hint if the query errored
// (custom event dimensions `plan_id` / `billing_period` not registered).
const PlanBreakdownSubSteps = ({ planBreakdown }) => {
  if (!planBreakdown) return null;
  if (planBreakdown.error) {
    return (
      <div className="mt-2 ml-4 pl-3 border-l-2 border-amber-100 text-[11px] text-amber-700">
        ↳ Plan breakdown unavailable — register{' '}
        <code className="text-[10px] px-1 bg-amber-50 rounded">plan_id</code> and{' '}
        <code className="text-[10px] px-1 bg-amber-50 rounded">billing_period</code>{' '}
        as event-scoped custom dimensions in GA4 Admin → Custom Definitions.
      </div>
    );
  }
  const rows = planBreakdown.rows || [];
  const meaningful = rows.filter(r => r.eventCount > 0 && r.plan !== '(not set)');
  if (meaningful.length === 0) return null;
  return (
    <div className="mt-2 ml-4 pl-3 border-l-2 border-gray-100 space-y-1">
      {meaningful.map((r, i) => (
        <div key={i} className="flex items-center justify-between text-xs">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-gray-600">↳ {r.plan}</span>
            {r.billingPeriod && r.billingPeriod !== '(not set)' && (
              <span className="text-[10px] text-gray-400 font-mono">{r.billingPeriod}</span>
            )}
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="tabular-nums text-gray-800">{fmtInt(r.users)} users</span>
            <span className="tabular-nums text-gray-400">{fmtInt(r.eventCount)} taps</span>
          </div>
        </div>
      ))}
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
  const [accounts, setAccounts] = useState([]);
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
        const [rows, accts] = await Promise.all([
          analyticsService.listAvailableProperties(),
          analyticsService.listConnectedAccounts().catch(() => []),
        ]);
        setProperties(rows);
        setAccounts(accts);
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
        ownerGoogleId: prop.ownerGoogleId,
        ownerEmail: prop.ownerEmail,
      });
      onConnected(row);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed to save property');
      setSelecting(null);
    }
  };

  // Group properties by owning Google account for a clearer picker UX when
  // the user has connected multiple accounts.
  const grouped = React.useMemo(() => {
    const map = new Map();
    properties.forEach(p => {
      const key = p.ownerEmail || p.ownerGoogleId || '__unknown__';
      if (!map.has(key)) map.set(key, { ownerEmail: p.ownerEmail, ownerGoogleId: p.ownerGoogleId, props: [] });
      map.get(key).props.push(p);
    });
    return Array.from(map.values());
  }, [properties]);

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
              {accounts.length > 0 && (
                <p className="text-xs text-gray-500 mb-4">
                  Connected Google accounts: {accounts.map(a => a.email || a.googleId).join(', ')}
                </p>
              )}
              <button
                onClick={() => loginForBusiness()}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700"
              >
                Connect another Google account
              </button>
              {err && (
                <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">{err}</div>
              )}
            </div>
          ) : (
            <div>
              <div className="flex items-start justify-between gap-3 mb-4">
                <p className="text-sm text-gray-500">
                  Pick a property to connect. You can connect multiple.
                </p>
                <button
                  onClick={() => loginForBusiness()}
                  className="flex-shrink-0 text-xs font-medium text-primary-600 hover:text-primary-700 whitespace-nowrap"
                  title="Sign in with a different Google account to see its GA4 properties"
                >
                  + Add Google account
                </button>
              </div>
              {err && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800 mb-3">{err}</div>
              )}
              <div className="space-y-4">
                {grouped.map(group => (
                  <div key={group.ownerEmail || group.ownerGoogleId || 'unknown'}>
                    {(grouped.length > 1 || group.ownerEmail) && (
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                        {group.ownerEmail || 'Unknown Google account'}
                      </p>
                    )}
                    <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md">
                      {group.props.map(p => (
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
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Analytics;
