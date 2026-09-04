import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Apple,
  Download,
  Star,
  AlertCircle,
  Link2,
  RefreshCw,
  Loader2,
  TrendingUp,
  Activity,
  Zap,
} from 'lucide-react';
import ascService from '../services/appStoreConnectService';

// Read-only Apple App Store Connect dashboard. Phase 1 covers three tabs:
//   Overview — daily install units rollup (Sales & Trends report)
//   Reviews  — latest customer reviews across territories
//   Apps     — every app the API key can see
//
// App Analytics (impressions, product page views, install conversion rate,
// sources) needs an async report flow + DB cache and lands in Phase 2. That
// data is the interesting signal for cross-referencing with paid campaigns;
// this Phase 1 dashboard exists to prove auth end-to-end and expose the
// data users can already fetch synchronously.

const DAY_RANGES = [
  { label: '7 days', value: 7 },
  { label: '14 days', value: 14 },
  { label: '30 days', value: 30 },
];

const fmtInt = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : '—';
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
};

// Apple's product type identifiers — https://developer.apple.com/help/app-store-connect/reference/product-type-identifiers/
// We only surface the human labels for the common ones.
const PRODUCT_TYPE_LABELS = {
  '1':   'New App',
  '1F':  'Universal (New)',
  '1T':  'iPad (New)',
  '7':   'App Update',
  '7F':  'Universal (Update)',
  '7T':  'iPad (Update)',
  '3':   'In-App Purchase',
  'IA1': 'In-App Purchase',
  'IA9': 'Subscription',
  'IAY': 'Auto-Renew Sub',
};

const Table = ({ children }) => (
  <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
    <table className="min-w-full divide-y divide-gray-200 text-sm">{children}</table>
  </div>
);
const Th = ({ children, className = '' }) => (
  <th className={`px-3 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide ${className}`}>{children}</th>
);
const Td = ({ children, className = '' }) => (
  <td className={`px-3 py-2 text-gray-700 ${className}`}>{children}</td>
);
const StatCard = ({ label, value, sub }) => (
  <div className="bg-white border border-gray-200 rounded-lg p-4">
    <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
    <p className="text-lg font-semibold text-gray-900 mt-0.5">{value}</p>
    {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
  </div>
);

const Stars = ({ n }) => {
  const rating = Math.max(0, Math.min(5, Number(n) || 0));
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <Star
          key={i}
          className={`h-3.5 w-3.5 ${i <= rating ? 'text-yellow-500 fill-yellow-500' : 'text-gray-300'}`}
        />
      ))}
    </span>
  );
};

const AppStoreConnect = () => {
  const navigate = useNavigate();

  const [connections, setConnections] = useState([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('overview');

  const [apps, setApps] = useState([]);
  const [selectedAppId, setSelectedAppId] = useState(null);
  const [days, setDays] = useState(7);

  const [sales, setSales] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [loadingSales, setLoadingSales] = useState(false);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [loadingApps, setLoadingApps] = useState(false);

  // Analytics (Phase 2)
  const [analyticsStatus, setAnalyticsStatus] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [sources, setSources] = useState(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [walking, setWalking] = useState(false);

  const selectedConnection = useMemo(
    () => connections.find(c => c.connectionId === selectedConnectionId) || null,
    [connections, selectedConnectionId]
  );

  // Load saved connections on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const list = await ascService.listConnected();
        if (cancelled) return;
        setConnections(list);
        if (list.length > 0 && !selectedConnectionId) {
          setSelectedConnectionId(list[0].connectionId);
        }
      } catch (e) {
        setError(e?.response?.data?.error || e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedConnectionId]);

  // Refresh apps list from Apple whenever the connection changes.
  useEffect(() => {
    if (!selectedConnectionId) return;
    let cancelled = false;
    (async () => {
      try {
        setLoadingApps(true);
        setError('');
        const res = await ascService.listApps(selectedConnectionId);
        if (cancelled) return;
        setApps(res.apps || []);
        setSelectedAppId(res.primaryAppId || res.apps?.[0]?.id || null);
      } catch (e) {
        setError(e?.response?.data?.error || e.message);
      } finally {
        if (!cancelled) setLoadingApps(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedConnectionId]);

  const loadSales = useCallback(async () => {
    if (!selectedConnectionId) return;
    try {
      setLoadingSales(true);
      setError('');
      const res = await ascService.getSales({ connectionId: selectedConnectionId, days });
      setSales(res);
    } catch (e) {
      const body = e?.response?.data || {};
      // Vendor number missing is a common Phase 1 friction point — surface
      // it with a specific inline hint instead of just the generic error.
      if (body.code === 'VENDOR_NUMBER_MISSING') {
        setSales(null);
        setError('Sales reports need a vendor number. Re-open the Apple App Store tile in Connections and paste it (find it in ASC → Payments & Financial Reports).');
      } else {
        setError(body.error || e.message);
      }
    } finally {
      setLoadingSales(false);
    }
  }, [selectedConnectionId, days]);

  const loadReviews = useCallback(async () => {
    if (!selectedConnectionId || !selectedAppId) return;
    try {
      setLoadingReviews(true);
      setError('');
      const res = await ascService.getReviews({
        connectionId: selectedConnectionId,
        appId: selectedAppId,
        limit: 50,
      });
      setReviews(res.reviews || []);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoadingReviews(false);
    }
  }, [selectedConnectionId, selectedAppId]);

  const loadAnalytics = useCallback(async () => {
    if (!selectedConnectionId) return;
    try {
      setLoadingAnalytics(true);
      setError('');
      const status = await ascService.analyticsStatus(selectedConnectionId);
      setAnalyticsStatus(status);
      if (status.bootstrapped && status.cachedInstances > 0) {
        const [f, s] = await Promise.all([
          ascService.analyticsFunnel(selectedConnectionId, days),
          ascService.analyticsSources(selectedConnectionId, days),
        ]);
        setFunnel(f);
        setSources(s);
      } else {
        setFunnel(null);
        setSources(null);
      }
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoadingAnalytics(false);
    }
  }, [selectedConnectionId, days]);

  const doBootstrap = async () => {
    if (!selectedConnectionId) return;
    setBootstrapping(true);
    setError('');
    try {
      await ascService.analyticsBootstrap(selectedConnectionId);
      await loadAnalytics();
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setBootstrapping(false);
    }
  };

  const doWalk = async () => {
    if (!selectedConnectionId) return;
    setWalking(true);
    setError('');
    try {
      await ascService.analyticsWalk(selectedConnectionId);
      await loadAnalytics();
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setWalking(false);
    }
  };

  // Fire the tab's loader when tab / selection changes.
  useEffect(() => {
    if (!selectedConnectionId) return;
    if (tab === 'overview') loadSales();
    if (tab === 'reviews') loadReviews();
    if (tab === 'analytics') loadAnalytics();
  }, [tab, selectedConnectionId, selectedAppId, days, loadSales, loadReviews, loadAnalytics]);

  // Aggregate sales rows into daily install totals (product type = new app install: 1, 1F, 1T)
  const dailyInstalls = useMemo(() => {
    if (!sales?.reports) return [];
    return sales.reports.map(rep => {
      const installUnits = (rep.rows || [])
        .filter(r => ['1', '1F', '1T'].includes(r.productType))
        .reduce((sum, r) => sum + (r.units || 0), 0);
      const updateUnits = (rep.rows || [])
        .filter(r => ['7', '7F', '7T'].includes(r.productType))
        .reduce((sum, r) => sum + (r.units || 0), 0);
      const iapUnits = (rep.rows || [])
        .filter(r => String(r.productType || '').startsWith('IA') || r.productType === '3')
        .reduce((sum, r) => sum + (r.units || 0), 0);
      return {
        reportDate: rep.reportDate,
        installs: installUnits,
        updates: updateUnits,
        iap: iapUnits,
        totalRows: (rep.rows || []).length,
      };
    });
  }, [sales]);

  const totals = useMemo(() => {
    const t = { installs: 0, updates: 0, iap: 0 };
    for (const d of dailyInstalls) {
      t.installs += d.installs;
      t.updates += d.updates;
      t.iap += d.iap;
    }
    return t;
  }, [dailyInstalls]);

  // ---------- render ----------

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-gray-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading Apple App Store connections…
      </div>
    );
  }

  if (connections.length === 0) {
    return (
      <div className="p-6">
        <div className="max-w-xl bg-white border border-gray-200 rounded-lg p-6 flex flex-col items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-gray-900 flex items-center justify-center">
            <Apple className="h-5 w-5 text-white" />
          </div>
          <h2 className="text-lg font-semibold text-gray-900">Connect Apple App Store</h2>
          <p className="text-sm text-gray-600">
            Sales, installs, and customer reviews for your iOS app. Requires an
            App Store Connect API key (.p8) — one-time paste from the ASC UI.
          </p>
          <button
            onClick={() => navigate('/connections')}
            className="inline-flex items-center gap-2 px-3 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
          >
            <Link2 className="h-4 w-4" />
            Add connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-gray-900 flex items-center justify-center">
            <Apple className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">App Store Connect</h1>
            <p className="text-xs text-gray-500">Read-only sales, installs, and reviews</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {connections.length > 1 && (
            <select
              value={selectedConnectionId || ''}
              onChange={e => setSelectedConnectionId(e.target.value)}
              className="px-2 py-1.5 text-sm border border-gray-300 rounded-md"
            >
              {connections.map(c => (
                <option key={c.connectionId} value={c.connectionId}>{c.displayName}</option>
              ))}
            </select>
          )}
          {apps.length > 0 && (
            <select
              value={selectedAppId || ''}
              onChange={e => setSelectedAppId(e.target.value)}
              className="px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              title="App"
            >
              {apps.map(a => (
                <option key={a.id} value={a.id}>{a.name || a.bundleId}</option>
              ))}
            </select>
          )}
          {tab === 'overview' && (
            <select
              value={days}
              onChange={e => setDays(Number(e.target.value))}
              className="px-2 py-1.5 text-sm border border-gray-300 rounded-md"
            >
              {DAY_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          )}
          <button
            onClick={() => {
              if (tab === 'overview') loadSales();
              else if (tab === 'reviews') loadReviews();
            }}
            className="p-1.5 border border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loadingSales || loadingReviews ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {selectedConnection && (
        <div className="text-xs text-gray-500">
          {selectedConnection.displayName}
          {selectedConnection.issuerId && <> · issuer <span className="font-mono">{selectedConnection.issuerId.slice(0, 8)}…</span></>}
          {!selectedConnection.hasVendorNumber && (
            <span className="ml-2 text-amber-700">
              (no vendor number — sales report disabled)
            </span>
          )}
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-200">
        {[
          { id: 'overview', label: 'Overview' },
          { id: 'analytics', label: 'Analytics' },
          { id: 'reviews', label: 'Reviews' },
          { id: 'apps', label: 'Apps' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition ${tab === t.id ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="min-w-0">{error}</span>
        </div>
      )}

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard label="New installs" value={fmtInt(totals.installs)} sub={`last ${days} days`} />
            <StatCard label="Updates" value={fmtInt(totals.updates)} sub={`last ${days} days`} />
            <StatCard label="In-app purchases" value={fmtInt(totals.iap)} sub={`last ${days} days`} />
          </div>
          <Table>
            <thead className="bg-gray-50">
              <tr>
                <Th>Date</Th>
                <Th className="text-right">Installs</Th>
                <Th className="text-right">Updates</Th>
                <Th className="text-right">IAP units</Th>
                <Th className="text-right">Rows</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loadingSales && (
                <tr><Td className="text-center text-gray-500" >Loading…</Td></tr>
              )}
              {!loadingSales && dailyInstalls.length === 0 && (
                <tr><Td className="text-center text-gray-500" colSpan={5}>No sales data available for this window.</Td></tr>
              )}
              {dailyInstalls.map(d => (
                <tr key={d.reportDate}>
                  <Td>{d.reportDate}</Td>
                  <Td className="text-right font-medium">{fmtInt(d.installs)}</Td>
                  <Td className="text-right text-gray-500">{fmtInt(d.updates)}</Td>
                  <Td className="text-right">{fmtInt(d.iap)}</Td>
                  <Td className="text-right text-gray-400 text-xs">{fmtInt(d.totalRows)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <button
            onClick={() => {
              const blob = new Blob([JSON.stringify(sales, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `asc-sales-${selectedAppId || 'account'}-${days}d.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            disabled={!sales}
            className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            Export raw JSON
          </button>
        </div>
      )}

      {tab === 'reviews' && (
        <div className="space-y-3">
          {loadingReviews && (
            <div className="text-sm text-gray-500 flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading reviews…
            </div>
          )}
          {!loadingReviews && reviews.length === 0 && (
            <div className="text-sm text-gray-500 border border-gray-200 rounded-lg p-6 text-center">
              No reviews returned for this app.
            </div>
          )}
          {reviews.map(r => (
            <div key={r.id} className="bg-white border border-gray-200 rounded-lg p-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <Stars n={r.rating} />
                  <span className="text-xs text-gray-500 truncate">
                    {r.reviewerNickname || 'Anonymous'}
                    {r.territory && <> · {r.territory}</>}
                  </span>
                </div>
                <span className="text-xs text-gray-400">{fmtDate(r.createdDate)}</span>
              </div>
              {r.title && <p className="text-sm font-medium text-gray-900">{r.title}</p>}
              {r.body && <p className="text-sm text-gray-700 whitespace-pre-wrap mt-0.5">{r.body}</p>}
            </div>
          ))}
        </div>
      )}

      {tab === 'analytics' && (
        <div className="space-y-4">
          {loadingAnalytics && !analyticsStatus && (
            <div className="text-sm text-gray-500 flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading analytics status…
            </div>
          )}

          {analyticsStatus && !analyticsStatus.bootstrapped && (
            <div className="bg-white border border-gray-200 rounded-lg p-6 flex flex-col items-start gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-50 flex items-center justify-center">
                <Activity className="h-5 w-5 text-blue-600" />
              </div>
              <h3 className="text-base font-semibold text-gray-900">Enable App Analytics</h3>
              <p className="text-sm text-gray-600">
                One-time setup. This tells Apple to start generating daily reports
                for your listing metrics (impressions, product page views, install
                conversion rate, source-type breakdown). The first daily report
                appears <strong>24-48 hours</strong> after enabling; subsequent
                reports arrive daily.
              </p>
              <button
                onClick={doBootstrap}
                disabled={bootstrapping}
                className="inline-flex items-center gap-2 px-3 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700 disabled:opacity-50"
              >
                {bootstrapping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                {bootstrapping ? 'Enabling…' : 'Enable App Analytics'}
              </button>
            </div>
          )}

          {analyticsStatus?.bootstrapped && analyticsStatus.cachedInstances === 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
              <p className="font-medium">Waiting for Apple's first report</p>
              <p className="mt-1 text-amber-800">
                App Analytics enabled at {fmtDate(analyticsStatus.bootstrapAt)}.
                Apple hasn't delivered a daily report yet — this takes 24-48 hours
                after enabling. The hourly cron will populate this tab automatically
                as reports arrive.
                {analyticsStatus.lastCheckAt && <> Last checked {new Date(analyticsStatus.lastCheckAt).toLocaleString()}.</>}
              </p>
              <button
                onClick={doWalk}
                disabled={walking}
                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-amber-900 border border-amber-300 rounded-md hover:bg-amber-100 disabled:opacity-50"
              >
                {walking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                {walking ? 'Checking Apple…' : 'Check now'}
              </button>
            </div>
          )}

          {funnel && funnel.dataCoverageDays > 0 && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Impressions" value={fmtInt(funnel.totals.impressions)} sub={`last ${days} days`} />
                <StatCard label="Page views" value={fmtInt(funnel.totals.productPageViews)} sub="unique-device" />
                <StatCard label="Installs" value={fmtInt(funnel.totals.installs)} sub="new + first-time" />
                <StatCard
                  label="Conversion rate"
                  value={funnel.totals.conversionRate != null
                    ? `${(funnel.totals.conversionRate * 100).toFixed(1)}%`
                    : '—'}
                  sub="installs / unique PPV"
                />
              </div>

              <div>
                <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5" />
                  Daily funnel
                </h3>
                <Table>
                  <thead className="bg-gray-50">
                    <tr>
                      <Th>Date</Th>
                      <Th className="text-right">Impressions</Th>
                      <Th className="text-right">Unique dev.</Th>
                      <Th className="text-right">Page views</Th>
                      <Th className="text-right">Installs</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {funnel.perDay.map(d => (
                      <tr key={d.date}>
                        <Td>{d.date}</Td>
                        <Td className="text-right">{fmtInt(d.impressions)}</Td>
                        <Td className="text-right text-gray-500">{fmtInt(d.impressionsUniqueDevice)}</Td>
                        <Td className="text-right">{fmtInt(d.productPageViews)}</Td>
                        <Td className="text-right font-medium">{fmtInt(d.installs)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </>
          )}

          {sources && sources.sources.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">
                Installs by source (paid vs organic)
              </h3>
              <Table>
                <thead className="bg-gray-50">
                  <tr>
                    <Th>Source</Th>
                    <Th className="text-right">Impressions</Th>
                    <Th className="text-right">Page views</Th>
                    <Th>Top campaigns</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sources.sources.map(s => (
                    <tr key={s.sourceType}>
                      <Td className="font-medium">{s.sourceType}</Td>
                      <Td className="text-right">{fmtInt(s.impressions)}</Td>
                      <Td className="text-right">{fmtInt(s.productPageViews)}</Td>
                      <Td className="text-xs text-gray-500">
                        {s.topCampaigns.length > 0
                          ? s.topCampaigns.slice(0, 3).map(c => `${c.campaign} (${fmtInt(c.productPageViews)} PPV)`).join(', ')
                          : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}

          {analyticsStatus?.bootstrapped && analyticsStatus.cachedInstances > 0 && (
            <div className="flex items-center justify-between text-xs text-gray-500 pt-2 border-t border-gray-100">
              <span>
                {analyticsStatus.cachedInstances} cached daily instances ·
                last check {analyticsStatus.lastCheckAt ? new Date(analyticsStatus.lastCheckAt).toLocaleString() : 'never'}
              </span>
              <button
                onClick={doWalk}
                disabled={walking}
                className="inline-flex items-center gap-1.5 px-2 py-1 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
              >
                {walking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                {walking ? 'Checking…' : 'Refresh from Apple'}
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'apps' && (
        <Table>
          <thead className="bg-gray-50">
            <tr>
              <Th>Name</Th>
              <Th>Bundle ID</Th>
              <Th>SKU</Th>
              <Th>Locale</Th>
              <Th>Apple ID</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loadingApps && (
              <tr><Td className="text-center text-gray-500" colSpan={5}>Loading…</Td></tr>
            )}
            {!loadingApps && apps.map(a => (
              <tr key={a.id} className={a.id === selectedAppId ? 'bg-primary-50/40' : ''}>
                <Td className="font-medium text-gray-900">{a.name || '—'}</Td>
                <Td className="font-mono text-xs">{a.bundleId || '—'}</Td>
                <Td className="text-gray-500">{a.sku || '—'}</Td>
                <Td className="text-gray-500">{a.primaryLocale || '—'}</Td>
                <Td className="font-mono text-xs text-gray-500">{a.id}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
};

export default AppStoreConnect;
