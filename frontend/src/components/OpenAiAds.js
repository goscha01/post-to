import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot,
  DollarSign,
  MousePointerClick,
  Target,
  TrendingUp,
  AlertCircle,
  Download,
  RefreshCw,
  Link2,
} from 'lucide-react';
import openAiAdsService from '../services/openAiAdsService';

// Read-only OpenAI Ads dashboard. Same shape as GoogleAds.js, minus the
// pieces the OpenAI Ads API doesn't expose (keywords, search terms, quality
// score, auction insights, change history). Every table is derived from an
// API call that hits api.ads.openai.com/v1 through the backend proxy.

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

const fmtMoney = (n) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '$0';
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
};

const fmtPercent = (rate) => {
  const v = Number(rate || 0);
  if (!Number.isFinite(v)) return '—';
  // OpenAI Ads returns ctr as a decimal (0.03 = 3%).
  return `${(v * 100).toFixed(2)}%`;
};

const fmtDate = (unix) => {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
};

const truncate = (s, n = 60) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// ---------- shared table primitives ----------
const Table = ({ children }) => (
  <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
    <table className="min-w-full divide-y divide-gray-200 text-sm">{children}</table>
  </div>
);
const Th = ({ children, className = '' }) => (
  <th className={`px-3 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide ${className}`}>{children}</th>
);
const Td = ({ children, className = '' }) => (
  <td className={`px-3 py-2 whitespace-nowrap text-gray-700 ${className}`}>{children}</td>
);
const StatCard = ({ label, value, icon: Icon }) => (
  <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-start gap-3">
    {Icon && (
      <div className="h-9 w-9 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
        <Icon className="h-5 w-5 text-gray-700" />
      </div>
    )}
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-lg font-semibold text-gray-900 truncate">{value}</p>
    </div>
  </div>
);

const OpenAiAds = () => {
  const navigate = useNavigate();
  const [connections, setConnections] = useState([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingReports, setLoadingReports] = useState(false);

  const [diag, setDiag] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [adGroups, setAdGroups] = useState([]);
  const [adsList, setAdsList] = useState([]);
  const [accountInsights, setAccountInsights] = useState([]);
  const [campaignInsights, setCampaignInsights] = useState([]);
  // Set true once loadConnected has resolved. Guards loadAll from firing
  // before we know whether the user has any openai_ads connections — without
  // this we call every endpoint with connectionId=undefined, which returns
  // 400 API_KEY_MISSING because the backend has no env fallback either.
  const [connectedLoaded, setConnectedLoaded] = useState(false);

  const selectedConnection = useMemo(
    () => connections.find(c => c.id === selectedConnectionId) || null,
    [connections, selectedConnectionId]
  );

  // Overview totals derived from account insights (time-series rows). Sum
  // impressions/clicks/spend; derive rates so we don't rely on rate columns
  // being pre-aggregated correctly across rows.
  const overview = useMemo(() => {
    if (!accountInsights || accountInsights.length === 0) return null;
    const totals = accountInsights.reduce((acc, r) => {
      acc.impressions += Number(r.impressions || 0);
      acc.clicks += Number(r.clicks || 0);
      acc.spend += Number(r.spend || 0);
      return acc;
    }, { impressions: 0, clicks: 0, spend: 0 });
    return {
      ...totals,
      ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : 0,
      cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
      cpm: totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0,
      days,
    };
  }, [accountInsights, days]);

  const loadConnected = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const rows = await openAiAdsService.listConnected();
      setConnections(rows);
      if (rows.length > 0) {
        const last = localStorage.getItem('post_to_openai_ads_connection_id');
        const match = last && rows.find(r => r.id === last);
        setSelectedConnectionId(match ? match.id : rows[0].id);
      } else {
        setSelectedConnectionId(null);
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load connections');
    } finally {
      setLoading(false);
      setConnectedLoaded(true);
    }
  }, []);

  const loadAll = useCallback(async (connectionId) => {
    if (!connectionId) return;
    setLoadingReports(true);
    setError('');
    try {
      const params = { connectionId };
      // Fire diagnose + list resources first. Insights sometimes 400s when
      // OpenAI Ads' feature flags for this account aren't ready — we still
      // want the resource tables to render.
      const [d, cList, aList, adList] = await Promise.all([
        openAiAdsService.diagnose(params).catch(() => null),
        openAiAdsService.getCampaigns(params).catch(() => []),
        openAiAdsService.getAdGroups(params).catch(() => []),
        openAiAdsService.getAds(params).catch(() => []),
      ]);
      setDiag(d);
      setCampaigns(cList);
      setAdGroups(aList);
      setAdsList(adList);
      const [acctIns, campIns] = await Promise.all([
        openAiAdsService.getInsights({ ...params, scope: 'account', days, granularity: 'daily' }).catch(err => {
          // Log the actual upstream body so we can debug in the browser
          // console until the network tab shows it too.
          // eslint-disable-next-line no-console
          console.warn('openai-ads insights (daily) failed:', err?.response?.data);
          return [];
        }),
        openAiAdsService.getInsights({ ...params, scope: 'account', days, granularity: 'none', aggregationLevel: 'campaign' }).catch(err => {
          // eslint-disable-next-line no-console
          console.warn('openai-ads insights (by campaign) failed:', err?.response?.data);
          return [];
        }),
      ]);
      setAccountInsights(acctIns);
      setCampaignInsights(campIns);
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load OpenAI Ads data');
    } finally {
      setLoadingReports(false);
    }
  }, [days]);

  useEffect(() => { loadConnected(); }, [loadConnected]);

  useEffect(() => {
    // Wait for loadConnected to finish. Firing loadAll before we know the
    // real connection id calls every endpoint with connectionId=undefined,
    // which triggers backend 400s (API_KEY_MISSING) unless
    // OPENAI_ADS_API_KEY is set in the env.
    if (!connectedLoaded) return;
    if (selectedConnectionId) {
      localStorage.setItem('post_to_openai_ads_connection_id', selectedConnectionId);
      loadAll(selectedConnectionId);
    }
    // If there are zero connections AND no env fallback expected, we
    // deliberately skip the load — the ConnectPrompt is shown instead.
  }, [connectedLoaded, selectedConnectionId, days, loadAll]);

  const handleExportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      rangeDays: days,
      connection: selectedConnection
        ? {
            id: selectedConnection.id,
            display_name: selectedConnection.display_name,
            ad_account_id: selectedConnection.metadata?.ad_account_id,
          }
        : null,
      diagnose: diag,
      overview,
      campaigns,
      adGroups,
      ads: adsList,
      accountInsights,
      campaignInsights,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    const idPart = selectedConnection?.metadata?.ad_account_id || 'env';
    a.download = `openai-ads-${idPart}-${days}d-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const canExport = !loadingReports && (accountInsights.length > 0 || campaigns.length > 0);

  const showConnectPrompt = connectedLoaded && !loading && connections.length === 0;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-gray-100 flex items-center justify-center">
            <Bot className="h-6 w-6 text-gray-900" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">OpenAI Ads</h1>
            <p className="text-sm text-gray-500">
              Read-only diagnostics via <code>api.ads.openai.com/v1</code>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {connections.length > 0 && (
            <select
              value={selectedConnectionId || ''}
              onChange={e => setSelectedConnectionId(e.target.value || null)}
              className="text-sm border border-gray-300 rounded-md px-2 py-1.5 bg-white"
            >
              {connections.map(c => (
                <option key={c.id} value={c.id}>
                  {c.display_name || c.metadata?.ad_account_id || 'OpenAI Ads'}
                </option>
              ))}
            </select>
          )}
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className="text-sm border border-gray-300 rounded-md px-2 py-1.5 bg-white"
          >
            {DAY_RANGES.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <button
            onClick={() => loadAll(selectedConnectionId)}
            disabled={loadingReports}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loadingReports ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={handleExportJson}
            disabled={!canExport}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-gray-900 text-white rounded-md hover:bg-gray-800 disabled:opacity-50"
            title="Download every table as one JSON payload"
          >
            <Download className="h-4 w-4" />
            JSON
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {diag && diag.hasKey && diag.keyOk === false && (
        <div className="mb-4 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-900">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">OpenAI Ads API rejected the stored key.</p>
            <p className="text-xs mt-0.5">
              {diag.error?.code}: {diag.error?.message}. Create a new key at{' '}
              <a href="https://ads.openai.com/settings" target="_blank" rel="noreferrer" className="underline">
                ads.openai.com/settings
              </a>{' '}
              and reconnect from Connections.
            </p>
          </div>
        </div>
      )}

      {showConnectPrompt ? (
        <ConnectPrompt onConnect={() => navigate('/connections')} />
      ) : loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <>
          <OverviewGrid overview={overview} />
          <Section title="Daily time-series">
            <InsightsTable rows={accountInsights} />
          </Section>
          <Section title="Campaigns">
            <CampaignsTable campaigns={campaigns} insights={campaignInsights} />
          </Section>
          <Section title="Ad groups">
            <AdGroupsTable adGroups={adGroups} />
          </Section>
          <Section title="Ads">
            <AdsTable ads={adsList} />
          </Section>
        </>
      )}
    </div>
  );
};

const Section = ({ title, children }) => (
  <div className="mt-6">
    <h2 className="text-sm font-semibold text-gray-800 mb-2">{title}</h2>
    {children}
  </div>
);

const ConnectPrompt = ({ onConnect }) => (
  <div className="text-center py-16 px-4 border-2 border-dashed border-gray-200 rounded-lg bg-white">
    <Bot className="h-10 w-10 text-gray-400 mx-auto mb-3" />
    <h3 className="text-base font-medium text-gray-900">No OpenAI Ads account connected</h3>
    <p className="text-sm text-gray-500 mt-1 mb-4">
      Paste an API key from ads.openai.com/settings + your ad account ID.
    </p>
    <button
      onClick={onConnect}
      className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-800"
    >
      <Link2 className="h-4 w-4" />
      Go to Connections
    </button>
  </div>
);

const OverviewGrid = ({ overview }) => {
  if (!overview) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <StatCard label="Impressions" value={fmtInt(overview.impressions)} icon={TrendingUp} />
      <StatCard label="Clicks" value={fmtInt(overview.clicks)} icon={MousePointerClick} />
      <StatCard label="Spend" value={fmtMoney(overview.spend)} icon={DollarSign} />
      <StatCard label="CTR" value={fmtPercent(overview.ctr)} icon={Target} />
      <StatCard label="CPC" value={fmtMoney(overview.cpc)} icon={DollarSign} />
      <StatCard label="CPM" value={fmtMoney(overview.cpm)} icon={DollarSign} />
    </div>
  );
};

const InsightsTable = ({ rows }) => {
  if (!rows || rows.length === 0) {
    return <p className="text-sm text-gray-500">No insights returned for this range.</p>;
  }
  return (
    <Table>
      <thead className="bg-gray-50">
        <tr>
          <Th>Date</Th>
          <Th className="text-right">Impressions</Th>
          <Th className="text-right">Clicks</Th>
          <Th className="text-right">Spend</Th>
          <Th className="text-right">CTR</Th>
          <Th className="text-right">CPC</Th>
          <Th className="text-right">CPM</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((r, i) => (
          <tr key={r.id || i}>
            <Td>{r.readable_time || fmtDate(r.start_time)}</Td>
            <Td className="text-right">{fmtInt(r.impressions)}</Td>
            <Td className="text-right">{fmtInt(r.clicks)}</Td>
            <Td className="text-right">{fmtMoney(r.spend)}</Td>
            <Td className="text-right">{fmtPercent(r.ctr)}</Td>
            <Td className="text-right">{fmtMoney(r.cpc)}</Td>
            <Td className="text-right">{fmtMoney(r.cpm)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
};

const CampaignsTable = ({ campaigns, insights }) => {
  if (!campaigns || campaigns.length === 0) {
    return <p className="text-sm text-gray-500">No campaigns found.</p>;
  }
  // Join per-campaign insights onto the campaign metadata row. Insights rows
  // have id = campaign id when aggregation_level=campaign.
  const insightsById = new Map();
  for (const r of (insights || [])) {
    if (r.id) insightsById.set(r.id, r);
  }
  return (
    <Table>
      <thead className="bg-gray-50">
        <tr>
          <Th>Name</Th>
          <Th>Status</Th>
          <Th>Start</Th>
          <Th>End</Th>
          <Th className="text-right">Budget</Th>
          <Th className="text-right">Impressions</Th>
          <Th className="text-right">Clicks</Th>
          <Th className="text-right">Spend</Th>
          <Th className="text-right">CTR</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {campaigns.map(c => {
          const m = insightsById.get(c.id) || {};
          const budgetMicros = c.budget?.lifetime_spend_limit_micros || c.budget?.daily_spend_limit_micros;
          const budget = budgetMicros ? Number(budgetMicros) / 1_000_000 : null;
          return (
            <tr key={c.id}>
              <Td className="font-medium text-gray-900">{truncate(c.name, 48)}</Td>
              <Td>
                <StatusPill status={c.status} />
              </Td>
              <Td className="text-xs">{fmtDate(c.start_time)}</Td>
              <Td className="text-xs">{fmtDate(c.end_time)}</Td>
              <Td className="text-right">{budget == null ? '—' : fmtMoney(budget)}</Td>
              <Td className="text-right">{fmtInt(m.impressions)}</Td>
              <Td className="text-right">{fmtInt(m.clicks)}</Td>
              <Td className="text-right">{fmtMoney(m.spend)}</Td>
              <Td className="text-right">{fmtPercent(m.ctr)}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
};

const AdGroupsTable = ({ adGroups }) => {
  if (!adGroups || adGroups.length === 0) {
    return <p className="text-sm text-gray-500">No ad groups.</p>;
  }
  return (
    <Table>
      <thead className="bg-gray-50">
        <tr>
          <Th>Name</Th>
          <Th>Status</Th>
          <Th>Campaign ID</Th>
          <Th>Description</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {adGroups.map(g => (
          <tr key={g.id}>
            <Td className="font-medium text-gray-900">{truncate(g.name, 48)}</Td>
            <Td><StatusPill status={g.status} /></Td>
            <Td className="text-xs font-mono">{g.campaign_id || '—'}</Td>
            <Td className="text-xs text-gray-600">{truncate(g.description, 60)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
};

const AdsTable = ({ ads }) => {
  if (!ads || ads.length === 0) {
    return <p className="text-sm text-gray-500">No ads.</p>;
  }
  return (
    <Table>
      <thead className="bg-gray-50">
        <tr>
          <Th>Name</Th>
          <Th>Status</Th>
          <Th>Ad group</Th>
          <Th>Type</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {ads.map(a => (
          <tr key={a.id}>
            <Td className="font-medium text-gray-900">{truncate(a.name, 48)}</Td>
            <Td><StatusPill status={a.status} /></Td>
            <Td className="text-xs font-mono">{a.ad_group_id || '—'}</Td>
            <Td className="text-xs">{a.type || a.creative?.type || '—'}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
};

const StatusPill = ({ status }) => {
  const s = String(status || '').toLowerCase();
  const bg =
    s === 'active' ? 'bg-green-50 text-green-700' :
    s === 'paused' ? 'bg-yellow-50 text-yellow-800' :
    s === 'archived' ? 'bg-gray-100 text-gray-600' :
    'bg-gray-50 text-gray-700';
  return <span className={`inline-block text-xs px-2 py-0.5 rounded ${bg}`}>{status || '—'}</span>;
};

export default OpenAiAds;
