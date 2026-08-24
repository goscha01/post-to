import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Facebook,
  DollarSign,
  Users,
  Eye,
  MousePointerClick,
  AlertTriangle,
  AlertCircle,
  Info,
  RefreshCw,
  Download,
  Check,
  X,
  Sparkles,
  Link2,
} from 'lucide-react';
import metaAdsService from '../services/metaAdsService';

// Read-only Meta Ads dashboard. Mirrors GoogleAds.js in visual language
// (day ranges, tabs, overview cards, diagnostics cards) so the mental model
// carries between the two products. Every response comes from
// /api/meta-ads/* — no direct Meta calls. No Apply/Pause/Budget buttons
// anywhere: mutations are Phase 2 and will run through Campaign Assistant.

const DAY_RANGES = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
];

const SECTIONS = [
  { key: 'overview',       label: 'Overview' },
  { key: 'diagnostics',    label: 'Diagnostics' },
  { key: 'campaigns',      label: 'Campaigns' },
  { key: 'adsets',         label: 'Ad Sets' },
  { key: 'ads',            label: 'Ads' },
  { key: 'placements',     label: 'Placements' },
  { key: 'creatives',      label: 'Creatives' },
  { key: 'devices',        label: 'Devices' },
  { key: 'demographics',   label: 'Demographics' },
  { key: 'dayHour',        label: 'Day & Hour' },
  { key: 'deliveryIssues', label: 'Delivery Issues' },
];

// -------- formatters --------

const fmtInt = (n) => {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString();
};
const fmtMoney = (n, currency = 'USD') => {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '$0';
  try {
    return v.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 2 });
  } catch {
    // Some legacy currency strings from Meta may not parse — fall back.
    return `${currency} ${v.toFixed(2)}`;
  }
};
const fmtPercent = (n, digits = 2) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}%`;
};
const fmtFixed = (n, digits = 2) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
};
const truncate = (s, n = 60) => (!s ? '' : s.length > n ? s.slice(0, n) + '…' : s);

// Human-readable label for a Meta objective. Falls back to the raw string
// so unknown objectives still render.
const OBJECTIVE_LABELS = {
  OUTCOME_LEADS: 'Leads',
  LEAD_GENERATION: 'Leads',
  OUTCOME_SALES: 'Sales',
  CONVERSIONS: 'Conversions',
  PRODUCT_CATALOG_SALES: 'Catalog Sales',
  OUTCOME_AWARENESS: 'Awareness',
  BRAND_AWARENESS: 'Brand Awareness',
  REACH: 'Reach',
  OUTCOME_TRAFFIC: 'Traffic',
  LINK_CLICKS: 'Link Clicks',
  OUTCOME_ENGAGEMENT: 'Engagement',
  POST_ENGAGEMENT: 'Post Engagement',
  OUTCOME_APP_PROMOTION: 'App Installs',
  APP_INSTALLS: 'App Installs',
  VIDEO_VIEWS: 'Video Views',
  MESSAGES: 'Messages',
  MESSAGING_CONVERSATIONS_STARTED: 'Messaging Conversations',
};
const RESULT_ACTION_LABELS = {
  lead: 'Lead',
  purchase: 'Purchase',
  omni_purchase: 'Purchase',
  'offsite_conversion.fb_pixel_purchase': 'Purchase',
  reach: 'Person Reached',
  link_click: 'Link Click',
  post_engagement: 'Post Engagement',
  page_engagement: 'Page Engagement',
  app_install: 'App Install',
  mobile_app_install: 'App Install',
  video_view: 'Video View',
  'onsite_conversion.messaging_conversation_started_7d': 'Messaging Conversation',
};
const objectiveLabel = (o) => OBJECTIVE_LABELS[o] || o || '—';
const resultActionLabel = (a) => RESULT_ACTION_LABELS[a] || a || '—';

// -------- top-level component --------

const MetaAds = () => {
  // Diagnose state — drives which connection banner to show.
  //   loading | connected | not_connected | missing_scope | token_invalid | error
  const [connState, setConnState] = useState({ status: 'loading' });

  const [accounts, setAccounts] = useState([]);
  const [selection, setSelection] = useState({ adAccountIds: [], defaultAdAccountId: null });
  const [selectedAdAccountId, setSelectedAdAccountId] = useState(null);

  const [days, setDays] = useState(30);

  // Report state — one variable per section keeps the JSX shallow.
  const [overview, setOverview] = useState(null);
  const [diagnosticsData, setDiagnosticsData] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [adsets, setAdsets] = useState([]);
  const [ads, setAds] = useState([]);
  const [placements, setPlacements] = useState({ rows: [] });
  const [devices, setDevices] = useState({ rows: [] });
  const [demographics, setDemographics] = useState({ rows: [] });
  const [dayHour, setDayHour] = useState({ rows: [] });
  const [creatives, setCreatives] = useState([]);
  const [deliveryIssues, setDeliveryIssues] = useState([]);

  const [loadingReports, setLoadingReports] = useState(false);
  const [error, setError] = useState('');
  const [activeSection, setActiveSection] = useState('overview');
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAdAccountId) || null,
    [accounts, selectedAdAccountId]
  );
  const currency = selectedAccount?.currency || 'USD';

  // -------- initial connection probe --------
  const runDiagnose = useCallback(async () => {
    try {
      const d = await metaAdsService.diagnoseAuth();
      if (!d.metaConnected) return setConnState({ status: 'not_connected' });
      if (!d.isValid) return setConnState({ status: 'token_invalid' });
      if (!d.hasAdsReadScope) return setConnState({ status: 'missing_scope' });
      setConnState({ status: 'connected', diagnose: d });
    } catch (e) {
      setConnState({ status: 'error', error: e?.message || 'Diagnose failed' });
    }
  }, []);

  // -------- account discovery --------
  const loadAccounts = useCallback(async () => {
    try {
      const r = await metaAdsService.listAvailableAccounts();
      if (r.code === 'META_NO_AD_ACCOUNTS') {
        setAccounts([]);
        setConnState({ status: 'no_accounts' });
        return;
      }
      setAccounts(r.accounts || []);
      setSelection(r.selection || { adAccountIds: [], defaultAdAccountId: null });
      // Prefer the last-used account from localStorage, else the saved
      // default, else the first accessible account.
      const remembered = localStorage.getItem('post_to_meta_ad_account_id');
      const savedIds = r.selection?.adAccountIds || [];
      const savedDefault = r.selection?.defaultAdAccountId;
      const first = (r.accounts || [])[0]?.id;
      let pick = null;
      if (remembered && savedIds.includes(remembered)) pick = remembered;
      else if (savedDefault) pick = savedDefault;
      else if (savedIds.length) pick = savedIds[0];
      else pick = first;
      setSelectedAdAccountId(pick);
    } catch (e) {
      const info = metaAdsService.interpretMetaError(e);
      if (info.intent === 'missing_scope') return setConnState({ status: 'missing_scope' });
      if (info.intent === 'token_invalid') return setConnState({ status: 'token_invalid' });
      if (info.intent === 'not_connected') return setConnState({ status: 'not_connected' });
      setError(info.message);
    }
  }, []);

  // -------- account selection: save picked account before it can be used --------
  const saveSelection = async (adAccountId) => {
    if (!adAccountId) return;
    setError('');
    try {
      const persisted = await metaAdsService.selectAccount({
        adAccountIds: [
          ...new Set([...(selection.adAccountIds || []), adAccountId]),
        ],
        defaultAdAccountId: adAccountId,
      });
      setSelection(persisted);
      setSelectedAdAccountId(adAccountId);
      localStorage.setItem('post_to_meta_ad_account_id', adAccountId);
    } catch (e) {
      const info = metaAdsService.interpretMetaError(e);
      setError(info.message);
    }
  };

  // -------- report load fanout --------
  const loadReports = useCallback(async (adAccountId, rangeDays) => {
    if (!adAccountId) return;
    setLoadingReports(true);
    setError('');
    try {
      const [ov, diag, camps, aset, adRows, plc, dev, dem, dh, cr, di] = await Promise.all([
        metaAdsService.getOverview(adAccountId, rangeDays),
        metaAdsService.getDiagnostics(adAccountId, rangeDays),
        metaAdsService.getCampaigns(adAccountId, rangeDays),
        metaAdsService.getAdSets(adAccountId, rangeDays),
        // /ads is capped at 90d server-side which matches our max, so this is safe
        metaAdsService.getAds(adAccountId, rangeDays),
        metaAdsService.getPlacements(adAccountId, rangeDays),
        metaAdsService.getDevices(adAccountId, rangeDays),
        metaAdsService.getDemographics(adAccountId, rangeDays),
        metaAdsService.getDayHour(adAccountId, rangeDays),
        metaAdsService.getCreatives(adAccountId),
        metaAdsService.getDeliveryIssues(adAccountId),
      ]);
      setOverview(ov);
      setDiagnosticsData(diag);
      setCampaigns(camps.campaigns || []);
      setAdsets(aset.adsets || []);
      setAds(adRows.ads || []);
      setPlacements(plc);
      setDevices(dev);
      setDemographics(dem);
      setDayHour(dh);
      setCreatives(cr.creatives || []);
      setDeliveryIssues(di.issues || []);
    } catch (e) {
      const info = metaAdsService.interpretMetaError(e);
      if (info.intent === 'missing_scope') return setConnState({ status: 'missing_scope' });
      if (info.intent === 'token_invalid') return setConnState({ status: 'token_invalid' });
      if (info.intent === 'not_connected') return setConnState({ status: 'not_connected' });
      if (info.intent === 'no_selection') {
        // The saved selection is out of sync — clear it and re-prompt.
        setSelection({ adAccountIds: [], defaultAdAccountId: null });
        setSelectedAdAccountId(null);
        return;
      }
      setError(info.message);
    } finally {
      setLoadingReports(false);
    }
  }, []);

  // ----- effects -----
  useEffect(() => {
    runDiagnose();
  }, [runDiagnose]);

  useEffect(() => {
    if (connState.status === 'connected') loadAccounts();
  }, [connState.status, loadAccounts]);

  useEffect(() => {
    if (
      connState.status === 'connected' &&
      selectedAdAccountId &&
      selection.adAccountIds?.includes(selectedAdAccountId)
    ) {
      loadReports(selectedAdAccountId, days);
    }
  }, [connState.status, selectedAdAccountId, selection.adAccountIds, days, loadReports]);

  const handleExportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      account: selectedAccount
        ? {
            id: selectedAccount.id,
            name: selectedAccount.name,
            currency: selectedAccount.currency,
            timezoneName: selectedAccount.timezoneName,
          }
        : null,
      rangeDays: days,
      overview,
      diagnostics: diagnosticsData,
      campaigns,
      adsets,
      ads,
      placements,
      devices,
      demographics,
      dayHour,
      creatives,
      deliveryIssues,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `meta-ads-${(selectedAdAccountId || 'unknown').replace(/[^a-z0-9_]/gi, '')}-${days}d-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const canExport = !!overview && !loadingReports;

  // ----- render: connection states dominate everything -----
  if (connState.status === 'loading') {
    return <div className="text-sm text-gray-500 p-4">Loading Meta Ads…</div>;
  }
  if (connState.status === 'not_connected') {
    return <NotConnectedState />;
  }
  if (connState.status === 'missing_scope') {
    return <MissingScopeState />;
  }
  if (connState.status === 'token_invalid') {
    return <TokenInvalidState />;
  }
  if (connState.status === 'error') {
    return (
      <div className="p-4 text-sm text-red-800 bg-red-50 border border-red-200 rounded-md">
        {connState.error}
      </div>
    );
  }
  if (connState.status === 'no_accounts') {
    return <NoAccountsState />;
  }

  // Connected but no ad account picked yet → picker
  const needsSelection =
    !selectedAdAccountId ||
    !selection.adAccountIds ||
    !selection.adAccountIds.includes(selectedAdAccountId);

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Facebook className="h-6 w-6 text-blue-600" />
            Meta Ads
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Facebook + Instagram · read-only campaign diagnostics. Actions run through Campaign Assistant.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {accounts.length > 0 && (
            <AccountSelector
              accounts={accounts}
              value={selectedAdAccountId}
              onChange={(id) => {
                if (selection.adAccountIds.includes(id)) {
                  setSelectedAdAccountId(id);
                  localStorage.setItem('post_to_meta_ad_account_id', id);
                } else {
                  saveSelection(id);
                }
              }}
            />
          )}
          <DayRangeSelector value={days} onChange={setDays} />
          <button
            onClick={() => selectedAdAccountId && loadReports(selectedAdAccountId, days)}
            disabled={!selectedAdAccountId || loadingReports}
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
            title="Download all tables as JSON (no tokens or connection metadata)"
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

      {needsSelection ? (
        <AccountPicker
          accounts={accounts}
          onPick={saveSelection}
          currentSelection={selection.adAccountIds}
        />
      ) : (
        <>
          {selectedAccount && (
            <p className="text-xs text-gray-500 mb-4">
              Ad account: <span className="font-medium text-gray-700">{selectedAccount.name || selectedAccount.id}</span>{' '}
              <span className="text-gray-400">({selectedAccount.id})</span>
              {selectedAccount.currency && (
                <> · <span className="text-gray-500">{selectedAccount.currency}</span></>
              )}
              {selectedAccount.timezoneName && (
                <> · <span className="text-gray-500">{selectedAccount.timezoneName}</span></>
              )}
              {selectedAccount.accountStatus === 101 && (
                <> · <span className="text-red-600 font-medium">Closed</span></>
              )}
            </p>
          )}

          <SectionTabs
            value={activeSection}
            onChange={setActiveSection}
            diagnosticsCount={diagnosticsData?.counts?.total || 0}
          />

          <div className="mt-6">
            {activeSection === 'overview'       && <OverviewCards overview={overview} loading={loadingReports} currency={currency} />}
            {activeSection === 'diagnostics'    && <DiagnosticsView data={diagnosticsData} loading={loadingReports} currency={currency} />}
            {activeSection === 'campaigns'      && <CampaignsTable rows={campaigns} loading={loadingReports} currency={currency} />}
            {activeSection === 'adsets'         && <AdSetsTable rows={adsets} loading={loadingReports} currency={currency} />}
            {activeSection === 'ads'            && <AdsTable rows={ads} loading={loadingReports} currency={currency} />}
            {activeSection === 'placements'     && <BreakdownTable rows={placements.rows} keys={['publisher_platform','platform_position']} loading={loadingReports} currency={currency} />}
            {activeSection === 'devices'        && <BreakdownTable rows={devices.rows} keys={['device_platform']} loading={loadingReports} currency={currency} />}
            {activeSection === 'demographics'   && <BreakdownTable rows={demographics.rows} keys={['age','gender']} loading={loadingReports} currency={currency} />}
            {activeSection === 'dayHour'        && <BreakdownTable rows={dayHour.rows} keys={['hourly_stats_aggregated_by_advertiser_time_zone']} loading={loadingReports} currency={currency} />}
            {activeSection === 'creatives'      && <CreativesGrid rows={creatives} loading={loadingReports} />}
            {activeSection === 'deliveryIssues' && <DeliveryIssuesList rows={deliveryIssues} loading={loadingReports} />}
          </div>
        </>
      )}
    </div>
  );
};

export default MetaAds;

// ============================================================================
// Sub-components — connection states, controls, sections
// ============================================================================

const NotConnectedState = () => (
  <div className="p-8 text-center border border-dashed border-gray-300 rounded-lg bg-white">
    <Facebook className="h-10 w-10 text-blue-600 mx-auto mb-3" />
    <h3 className="text-base font-medium text-gray-900">Connect Meta to see Ads reporting</h3>
    <p className="text-sm text-gray-600 mt-2 max-w-md mx-auto">
      Post-to reports on Facebook and Instagram ad campaigns using your existing Meta account.
      Head to Connections to link your Facebook Business Account.
    </p>
    <a
      href="/connections"
      className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700"
    >
      Go to Connections
    </a>
  </div>
);

const MissingScopeState = () => (
  <div className="p-6 border border-blue-200 bg-blue-50 rounded-lg">
    <div className="flex items-start gap-3">
      <Facebook className="h-6 w-6 text-blue-600 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <h3 className="text-base font-medium text-blue-900">
          Reconnect Meta for Ads reporting
        </h3>
        <p className="text-sm text-blue-800 mt-1">
          Your Facebook connection is working for organic posting but doesn't include ads reporting
          permission (<code className="text-xs bg-blue-100 px-1 py-0.5 rounded">ads_read</code>).
          Reconnect Meta and approve the Ads permission when Facebook prompts you. Your existing
          Pages and Instagram accounts remain connected.
        </p>
        <a
          href="/connections"
          className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700"
        >
          <RefreshCw className="h-4 w-4" />
          Reconnect on Connections page
        </a>
      </div>
    </div>
  </div>
);

const TokenInvalidState = () => (
  <div className="p-6 border border-amber-200 bg-amber-50 rounded-lg">
    <div className="flex items-start gap-3">
      <AlertCircle className="h-6 w-6 text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <h3 className="text-base font-medium text-amber-900">Meta connection expired</h3>
        <p className="text-sm text-amber-800 mt-1">
          Your Meta access token has expired or was revoked. Reconnect to continue reporting.
        </p>
        <a
          href="/connections"
          className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-md hover:bg-amber-700"
        >
          <RefreshCw className="h-4 w-4" />
          Reconnect Meta
        </a>
      </div>
    </div>
  </div>
);

const NoAccountsState = () => (
  <div className="p-8 text-center border border-dashed border-gray-300 rounded-lg bg-white">
    <Info className="h-10 w-10 text-gray-400 mx-auto mb-3" />
    <h3 className="text-base font-medium text-gray-900">No accessible ad accounts</h3>
    <p className="text-sm text-gray-600 mt-2 max-w-md mx-auto">
      Your Meta account is connected but doesn't have access to any ad accounts. Ask an admin of
      your Business Manager to grant this user access, then refresh this page.
    </p>
  </div>
);

const AccountPicker = ({ accounts, onPick, currentSelection = [] }) => (
  <div className="p-6 border border-gray-200 bg-white rounded-lg">
    <h3 className="text-base font-medium text-gray-900 mb-2">Choose a Meta ad account</h3>
    <p className="text-sm text-gray-500 mb-4">
      Pick the account you want to report on. You can switch later.
    </p>
    <ul className="divide-y divide-gray-100">
      {accounts.map((a) => (
        <li key={a.id} className="py-3 flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-gray-900 truncate">
              {a.name || a.id}
              {currentSelection.includes(a.id) && (
                <span className="ml-2 inline-flex items-center text-xs text-green-700"><Check className="h-3 w-3 mr-0.5" />Saved</span>
              )}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              {a.id}
              {a.currency && ` · ${a.currency}`}
              {a.timezoneName && ` · ${a.timezoneName}`}
              {a.accountStatus === 101 && <span className="text-red-600"> · Closed</span>}
            </div>
          </div>
          <button
            onClick={() => onPick(a.id)}
            className="ml-4 text-sm px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Use this account
          </button>
        </li>
      ))}
    </ul>
  </div>
);

const AccountSelector = ({ accounts, value, onChange }) => (
  <div className="inline-flex items-center gap-2 bg-white border border-gray-300 rounded-md px-3 py-2">
    <Link2 className="h-4 w-4 text-gray-400" />
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className="text-sm text-gray-700 bg-transparent border-0 focus:ring-0 focus:outline-none pr-6"
    >
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {(a.name || a.id) + ' — ' + a.id}
        </option>
      ))}
    </select>
  </div>
);

const DayRangeSelector = ({ value, onChange }) => (
  <div className="inline-flex bg-white border border-gray-300 rounded-md p-1">
    {DAY_RANGES.map((r) => (
      <button
        key={r.value}
        onClick={() => onChange(r.value)}
        className={`px-3 py-1.5 text-sm rounded ${
          value === r.value ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-50'
        }`}
      >
        {r.label}
      </button>
    ))}
  </div>
);

const SectionTabs = ({ value, onChange, diagnosticsCount }) => (
  <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
    {SECTIONS.map((s) => (
      <button
        key={s.key}
        onClick={() => onChange(s.key)}
        className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${
          value === s.key
            ? 'text-blue-700 border-blue-600'
            : 'text-gray-600 hover:text-gray-900 border-transparent'
        }`}
      >
        {s.label}
        {s.key === 'diagnostics' && diagnosticsCount > 0 && (
          <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] px-1 py-0 text-[10px] font-semibold rounded-full bg-red-100 text-red-700">
            {diagnosticsCount}
          </span>
        )}
      </button>
    ))}
  </div>
);

// -------- overview cards --------

const OverviewCards = ({ overview, loading, currency }) => {
  if (loading && !overview) return <div className="text-sm text-gray-500">Loading…</div>;
  if (!overview) return <div className="text-sm text-gray-500">No data.</div>;
  const t = overview.totals || {};
  const singleResult = overview.results?.value !== null && overview.results?.value !== undefined;
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={DollarSign} label="Spend" value={fmtMoney(t.spend, currency)} />
        <StatCard icon={Eye} label="Impressions" value={fmtInt(t.impressions)} />
        <StatCard icon={Users} label="Reach" value={fmtInt(t.reach)} />
        <StatCard icon={MousePointerClick} label="Frequency" value={fmtFixed(t.frequency)} />
        <StatCard icon={MousePointerClick} label="Clicks / CTR" value={`${fmtInt(t.clicks)} · ${fmtPercent(t.ctr)}`} />
        <StatCard icon={DollarSign} label="CPC" value={fmtMoney(t.cpc, currency)} />
        <StatCard icon={DollarSign} label="CPM" value={fmtMoney(t.cpm, currency)} />
        <StatCard
          icon={Sparkles}
          label={singleResult ? resultActionLabel(overview.results.actionType) : 'Campaigns'}
          value={
            singleResult
              ? fmtInt(overview.results.value)
              : fmtInt(overview.campaignCount || 0)
          }
        />
      </div>

      {/* Results breakdown when the account has multiple objective types.
          We never sum results across objectives — show them side by side. */}
      {(!singleResult && (overview.resultsByObjective || []).length > 0) && (
        <div className="mt-4 border border-gray-200 rounded-lg bg-white">
          <div className="px-4 py-2 border-b border-gray-100 text-xs font-medium text-gray-600 uppercase tracking-wide">
            Results by objective
          </div>
          <ul className="divide-y divide-gray-100">
            {overview.resultsByObjective.map((b) => (
              <li key={b.objective} className="px-4 py-2.5 flex items-center justify-between text-sm">
                <div>
                  <div className="font-medium text-gray-900">{objectiveLabel(b.objective)}</div>
                  <div className="text-xs text-gray-500">
                    {resultActionLabel(b.actionType)} · {fmtInt(b.results)} results · {fmtMoney(b.spend, currency)} spent
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-500">Cost per result</div>
                  <div className="font-medium text-gray-900">
                    {b.costPerResult ? fmtMoney(b.costPerResult, currency) : '—'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {singleResult && overview.costPerResult && (
        <div className="mt-3 text-xs text-gray-500">
          Cost per {resultActionLabel(overview.results.actionType).toLowerCase()}:{' '}
          <span className="font-medium text-gray-800">{fmtMoney(overview.costPerResult, currency)}</span>
        </div>
      )}
    </div>
  );
};

const StatCard = ({ icon: Icon, label, value }) => (
  <div className="p-3 bg-white border border-gray-200 rounded-md">
    <div className="text-xs text-gray-500 uppercase tracking-wide flex items-center gap-1">
      {Icon && <Icon className="h-3 w-3" />} {label}
    </div>
    <div className="mt-1 text-lg font-semibold text-gray-900">{value}</div>
  </div>
);

// -------- diagnostics --------

const SEVERITY_STYLES = {
  high:   { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-900', icon: AlertTriangle, iconColor: 'text-red-600', badge: 'bg-red-100 text-red-800' },
  medium: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-900', icon: AlertCircle, iconColor: 'text-amber-600', badge: 'bg-amber-100 text-amber-800' },
  low:    { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-800', icon: Info, iconColor: 'text-gray-500', badge: 'bg-gray-100 text-gray-700' },
};

const DiagnosticsView = ({ data, loading, currency }) => {
  if (loading && !data) return <div className="text-sm text-gray-500">Running diagnostics…</div>;
  if (!data) return <div className="text-sm text-gray-500">No diagnostics data.</div>;
  const issues = data.issues || [];
  const c = data.counts || {};

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 text-sm">
        <span className="text-gray-600">{c.total || 0} issue{c.total === 1 ? '' : 's'} found</span>
        {c.high > 0 && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-800 text-xs font-medium">{c.high} high</span>}
        {c.medium > 0 && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-medium">{c.medium} medium</span>}
        {c.low > 0 && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">{c.low} low</span>}
      </div>

      {issues.length === 0 ? (
        <div className="p-6 border border-green-200 bg-green-50 rounded-md text-sm text-green-800 flex items-start gap-2">
          <Check className="h-4 w-4 mt-0.5" />
          <span>No issues detected in the current window. Meta reports normal delivery on every active campaign, ad set, and ad.</span>
        </div>
      ) : (
        <ul className="space-y-3">
          {issues.map((iss) => (
            <IssueCard key={iss.id} issue={iss} currency={currency} />
          ))}
        </ul>
      )}
    </div>
  );
};

const IssueCard = ({ issue, currency }) => {
  const s = SEVERITY_STYLES[issue.severity] || SEVERITY_STYLES.low;
  const Icon = s.icon;
  return (
    <li className={`p-4 border ${s.border} ${s.bg} rounded-md`}>
      <div className="flex items-start gap-3">
        <Icon className={`h-5 w-5 ${s.iconColor} flex-shrink-0 mt-0.5`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className={`text-sm font-semibold ${s.text}`}>{issue.title}</h4>
            <span className={`text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded ${s.badge}`}>{issue.severity}</span>
            {issue.source === 'meta' && (
              <span className="text-[10px] uppercase font-medium text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">Meta</span>
            )}
            {issue.entityIds?.length > 0 && (
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">
                {issue.entityIds.length} {issue.entityType}{issue.entityIds.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <p className={`text-sm mt-1 ${s.text} opacity-90`}>{issue.guidance}</p>
          <IssueMetrics metrics={issue.metrics} currency={currency} />
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => { window.location.href = `/campaign-assistant?intent=meta_review&issueId=${encodeURIComponent(issue.id)}`; }}
              className="text-xs font-medium text-blue-700 hover:text-blue-900 inline-flex items-center gap-1"
              title="Send this diagnostic to Campaign Assistant"
            >
              Review with Campaign Assistant →
            </button>
          </div>
        </div>
      </div>
    </li>
  );
};

// Render metric key/value pairs compactly. Numbers get comma formatting,
// money uses the account currency, percents are auto-detected on `ctr`,
// `deliveryRatio`, etc.
const IssueMetrics = ({ metrics, currency }) => {
  if (!metrics || typeof metrics !== 'object') return null;
  const entries = Object.entries(metrics).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return null;
  return (
    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-1">
          <dt className="uppercase tracking-wide text-gray-500">{k}:</dt>
          <dd className="font-medium text-gray-800">{formatMetricValue(k, v, currency)}</dd>
        </div>
      ))}
    </dl>
  );
};

function formatMetricValue(key, v, currency) {
  const moneyKeys = new Set(['spend', 'costPerResult', 'peerAvgCostPerResult', 'dailyBudget', 'expectedSpend', 'actualSpend']);
  const pctKeys = new Set(['ctr', 'deliveryRatio']);
  if (moneyKeys.has(key)) return fmtMoney(v, currency);
  if (pctKeys.has(key)) return typeof v === 'number' && v < 1 ? fmtPercent(v * 100) : fmtPercent(v);
  if (typeof v === 'number') return fmtInt(v);
  return String(v);
}

// -------- section tables --------

const CampaignsTable = ({ rows, loading, currency }) => {
  if (loading && rows.length === 0) return <div className="text-sm text-gray-500">Loading…</div>;
  if (!rows.length) return <div className="text-sm text-gray-500">No campaigns in this window.</div>;
  return (
    <div className="overflow-x-auto border border-gray-200 rounded-md bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="text-left px-3 py-2">Campaign</th>
            <th className="text-left px-3 py-2">Objective</th>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-right px-3 py-2">Spend</th>
            <th className="text-right px-3 py-2">Impressions</th>
            <th className="text-right px-3 py-2">Clicks</th>
            <th className="text-right px-3 py-2">CTR</th>
            <th className="text-right px-3 py-2">Results</th>
            <th className="text-right px-3 py-2">Cost / result</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => {
            const ins = r.insights || {};
            const der = r.derivedResults || {};
            return (
              <tr key={r.id}>
                <td className="px-3 py-2 truncate max-w-xs">{truncate(r.name || `Campaign ${r.id}`, 50)}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{objectiveLabel(r.objective)}</td>
                <td className="px-3 py-2 text-xs">
                  <StatusPill status={r.effectiveStatus} />
                </td>
                <td className="px-3 py-2 text-right">{fmtMoney(ins.spend, currency)}</td>
                <td className="px-3 py-2 text-right">{fmtInt(ins.impressions)}</td>
                <td className="px-3 py-2 text-right">{fmtInt(ins.clicks)}</td>
                <td className="px-3 py-2 text-right">{fmtPercent(ins.ctr)}</td>
                <td className="px-3 py-2 text-right">{der.results !== null && der.results !== undefined ? fmtInt(der.results) : '—'}</td>
                <td className="px-3 py-2 text-right">{der.costPerResult ? fmtMoney(der.costPerResult, currency) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const AdSetsTable = ({ rows, loading, currency }) => {
  if (loading && rows.length === 0) return <div className="text-sm text-gray-500">Loading…</div>;
  if (!rows.length) return <div className="text-sm text-gray-500">No ad sets in this window.</div>;
  return (
    <div className="overflow-x-auto border border-gray-200 rounded-md bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="text-left px-3 py-2">Ad Set</th>
            <th className="text-left px-3 py-2">Optim. goal</th>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-right px-3 py-2">Daily budget</th>
            <th className="text-right px-3 py-2">Spend</th>
            <th className="text-right px-3 py-2">Impressions</th>
            <th className="text-right px-3 py-2">Results</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => {
            const ins = r.insights || {};
            const der = r.derivedResults || {};
            return (
              <tr key={r.id}>
                <td className="px-3 py-2 truncate max-w-xs">{truncate(r.name || `Ad Set ${r.id}`, 50)}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{r.optimizationGoal || '—'}</td>
                <td className="px-3 py-2 text-xs">
                  <StatusPill status={r.effectiveStatus} />
                </td>
                <td className="px-3 py-2 text-right">{r.dailyBudget ? fmtMoney(r.dailyBudget / 100, currency) : '—'}</td>
                <td className="px-3 py-2 text-right">{fmtMoney(ins.spend, currency)}</td>
                <td className="px-3 py-2 text-right">{fmtInt(ins.impressions)}</td>
                <td className="px-3 py-2 text-right">{der.results !== null && der.results !== undefined ? fmtInt(der.results) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const AdsTable = ({ rows, loading, currency }) => {
  if (loading && rows.length === 0) return <div className="text-sm text-gray-500">Loading…</div>;
  if (!rows.length) return <div className="text-sm text-gray-500">No ads in this window.</div>;
  return (
    <div className="overflow-x-auto border border-gray-200 rounded-md bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="text-left px-3 py-2">Ad</th>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-right px-3 py-2">Spend</th>
            <th className="text-right px-3 py-2">Impressions</th>
            <th className="text-right px-3 py-2">Reach</th>
            <th className="text-right px-3 py-2">Frequency</th>
            <th className="text-right px-3 py-2">CTR</th>
            <th className="text-right px-3 py-2">Results</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => {
            const ins = r.insights || {};
            const der = r.derivedResults || {};
            return (
              <tr key={r.id}>
                <td className="px-3 py-2 truncate max-w-xs">{truncate(r.name || `Ad ${r.id}`, 50)}</td>
                <td className="px-3 py-2 text-xs">
                  <StatusPill status={r.effectiveStatus} />
                </td>
                <td className="px-3 py-2 text-right">{fmtMoney(ins.spend, currency)}</td>
                <td className="px-3 py-2 text-right">{fmtInt(ins.impressions)}</td>
                <td className="px-3 py-2 text-right">{fmtInt(ins.reach)}</td>
                <td className="px-3 py-2 text-right">{fmtFixed(ins.frequency)}</td>
                <td className="px-3 py-2 text-right">{fmtPercent(ins.ctr)}</td>
                <td className="px-3 py-2 text-right">{der.results !== null && der.results !== undefined ? fmtInt(der.results) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// Generic breakdown renderer for placements/devices/demographics/day-hour.
// Passes through whatever breakdown keys the caller provides.
const BreakdownTable = ({ rows, keys, loading, currency }) => {
  if (loading && rows.length === 0) return <div className="text-sm text-gray-500">Loading…</div>;
  if (!rows.length) return <div className="text-sm text-gray-500">No breakdown data in this window.</div>;
  return (
    <div className="overflow-x-auto border border-gray-200 rounded-md bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            {keys.map((k) => (
              <th key={k} className="text-left px-3 py-2 text-xs uppercase">
                {k.replace(/_/g, ' ')}
              </th>
            ))}
            <th className="text-right px-3 py-2">Spend</th>
            <th className="text-right px-3 py-2">Impressions</th>
            <th className="text-right px-3 py-2">Clicks</th>
            <th className="text-right px-3 py-2">CTR</th>
            <th className="text-right px-3 py-2">CPM</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, i) => (
            <tr key={i}>
              {keys.map((k) => (
                <td key={k} className="px-3 py-2 text-xs text-gray-700">
                  {r.breakdowns?.[k] ?? '—'}
                </td>
              ))}
              <td className="px-3 py-2 text-right">{fmtMoney(r.spend, currency)}</td>
              <td className="px-3 py-2 text-right">{fmtInt(r.impressions)}</td>
              <td className="px-3 py-2 text-right">{fmtInt(r.clicks)}</td>
              <td className="px-3 py-2 text-right">{fmtPercent(r.ctr)}</td>
              <td className="px-3 py-2 text-right">{fmtMoney(r.cpm, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const CreativesGrid = ({ rows, loading }) => {
  if (loading && rows.length === 0) return <div className="text-sm text-gray-500">Loading…</div>;
  if (!rows.length) return <div className="text-sm text-gray-500">No creatives.</div>;
  return (
    <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {rows.map((r) => (
        <li key={r.id} className="border border-gray-200 rounded-md bg-white overflow-hidden">
          {r.thumbnailUrl ? (
            <img src={r.thumbnailUrl} alt="" className="w-full h-40 object-cover bg-gray-100" />
          ) : (
            <div className="w-full h-40 bg-gray-100 flex items-center justify-center text-gray-400 text-xs">
              No preview
            </div>
          )}
          <div className="p-3">
            <div className="text-sm font-medium text-gray-900 truncate">{r.name || `Creative ${r.id}`}</div>
            {r.title && <div className="text-xs text-gray-600 mt-0.5 truncate">{r.title}</div>}
            {r.body && <div className="text-xs text-gray-500 mt-1 line-clamp-2">{r.body}</div>}
            {r.callToActionType && (
              <div className="mt-2 inline-block px-2 py-0.5 bg-gray-100 text-xs text-gray-700 rounded">
                {r.callToActionType.replace(/_/g, ' ')}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
};

const DeliveryIssuesList = ({ rows, loading }) => {
  if (loading && rows.length === 0) return <div className="text-sm text-gray-500">Loading…</div>;
  if (!rows.length) {
    return (
      <div className="p-6 border border-green-200 bg-green-50 rounded-md text-sm text-green-800 flex items-start gap-2">
        <Check className="h-4 w-4 mt-0.5" />
        <span>Meta reports no delivery issues on this account.</span>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {rows.map((r, i) => (
        <li key={`${r.entityType}-${r.entityId}-${i}`} className="p-3 border border-red-200 bg-red-50 rounded-md">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-sm font-medium text-red-900">
                {r.issue?.error_summary || 'Delivery issue'}
              </div>
              <div className="text-xs text-red-800 mt-1">{r.issue?.error_message}</div>
              <div className="text-[10px] uppercase tracking-wide text-red-700 mt-1.5">
                {r.entityType} · {truncate(r.entityName || r.entityId, 60)} · {r.effectiveStatus}
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
};

const StatusPill = ({ status }) => {
  if (!status) return <span className="text-gray-400">—</span>;
  const map = {
    ACTIVE:            'bg-green-100 text-green-800',
    PAUSED:            'bg-gray-100 text-gray-700',
    CAMPAIGN_PAUSED:   'bg-gray-100 text-gray-700',
    ADSET_PAUSED:      'bg-gray-100 text-gray-700',
    ARCHIVED:          'bg-gray-100 text-gray-700',
    DELETED:           'bg-gray-100 text-gray-700',
    WITH_ISSUES:       'bg-red-100 text-red-800',
    DISAPPROVED:       'bg-red-100 text-red-800',
    PENDING_REVIEW:    'bg-amber-100 text-amber-800',
    PENDING_BILLING_INFO: 'bg-amber-100 text-amber-800',
    IN_PROCESS:        'bg-blue-100 text-blue-800',
  };
  return <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-medium ${map[status] || 'bg-gray-100 text-gray-700'}`}>{status}</span>;
};
