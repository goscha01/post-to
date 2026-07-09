import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  Megaphone,
  DollarSign,
  MousePointerClick,
  Target,
  TrendingUp,
  AlertCircle,
  AlertTriangle,
  Plus,
  Link2,
  Download,
  RefreshCw,
  X,
  Check,
  Smartphone,
  Monitor,
  Tablet,
  Search,
  Lightbulb,
  Clock,
  MapPin,
  Users,
  ClipboardCheck,
  History,
} from 'lucide-react';
import googleAdsService from '../services/googleAdsService';

// Google Ads dashboard — READ ONLY. Same visual patterns as Analytics.js so
// the user has a consistent mental model. Every section below maps to a
// GAQL SELECT on the backend.

const DAY_RANGES = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '180 days', value: 180 },
  { label: '365 days', value: 365 },
];

const SECTIONS = [
  { key: 'overview',        label: 'Overview' },
  { key: 'diagnostics',     label: 'Diagnostics' },
  { key: 'campaigns',       label: 'Campaigns' },
  { key: 'adGroups',        label: 'Ad Groups' },
  { key: 'keywords',        label: 'Keywords' },
  { key: 'searchTerms',     label: 'Search Terms' },
  { key: 'ads',             label: 'Ads' },
  { key: 'assets',          label: 'Assets' },
  { key: 'recommendations', label: 'Recommendations' },
  { key: 'conversions',     label: 'Conversions' },
  { key: 'devices',         label: 'Devices' },
  { key: 'locations',       label: 'Locations' },
  { key: 'dayHour',         label: 'Day & Hour' },
  { key: 'audience',        label: 'Audience' },
  { key: 'auctionInsights', label: 'Auction' },
  { key: 'quality',         label: 'Quality' },
  { key: 'changeHistory',   label: 'Changes' },
];

const fmtInt = (n) => {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString();
};

const fmtMoney = (n, currency = 'USD') => {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '$0';
  return v.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 2 });
};

const fmtPercent = (rate) => {
  const v = Number(rate || 0);
  if (!Number.isFinite(v)) return '—';
  // Google Ads returns rates as decimals (0.42 = 42%).
  return `${(v * 100).toFixed(2)}%`;
};

const fmtFixed = (n, digits = 2) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
};

const truncate = (s, n = 60) => {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const GoogleAds = () => {
  const { user } = useAuth();

  const [connectedCustomers, setConnectedCustomers] = useState([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [days, setDays] = useState(30);
  // Optional campaign filter. null = "All campaigns". Available options come
  // from the Campaigns tab (always fetched first), so once we load them the
  // dropdown is ready to switch to a single campaign, which re-fetches every
  // report scoped to it.
  const [campaignId, setCampaignId] = useState(null);
  const [allCampaignOptions, setAllCampaignOptions] = useState([]);

  const [campaigns, setCampaigns] = useState([]);
  const [adGroups, setAdGroups] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [searchTerms, setSearchTerms] = useState([]);
  const [adsList, setAdsList] = useState([]);
  const [assets, setAssets] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [conversions, setConversions] = useState([]);
  const [devices, setDevices] = useState([]);
  const [locations, setLocations] = useState([]);
  const [dayHour, setDayHour] = useState([]);
  const [audience, setAudience] = useState({ ageRanges: [], genders: [] });
  const [auctionInsights, setAuctionInsights] = useState([]);
  const [quality, setQuality] = useState([]);
  const [changeHistory, setChangeHistory] = useState({ events: [], summary: [], caps: null, requestedDays: null, unavailableBeyondDays: null });
  const [diagnostics, setDiagnostics] = useState(null);

  const [loading, setLoading] = useState(true);
  const [loadingReports, setLoadingReports] = useState(false);
  const [error, setError] = useState('');
  const [needsCustomerSelection, setNeedsCustomerSelection] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [devTokenMissing, setDevTokenMissing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('overview');

  const selectedCustomer = useMemo(
    () => connectedCustomers.find(c => c.customerId === selectedCustomerId) || null,
    [connectedCustomers, selectedCustomerId]
  );

  const currency = selectedCustomer?.currencyCode || 'USD';

  // Overview is derived from the campaigns table — sum of top-level totals so
  // we don't need an extra API round-trip. This is what ChatGPT will see when
  // asked "how's this account doing overall".
  const overview = useMemo(() => {
    if (!campaigns || campaigns.length === 0) return null;
    const totals = campaigns.reduce((acc, c) => {
      acc.spend += Number(c.spend || 0);
      acc.clicks += Number(c.clicks || 0);
      acc.impressions += Number(c.impressions || 0);
      acc.conversions += Number(c.conversions || 0);
      acc.conversionValue += Number(c.conversionValue || 0);
      return acc;
    }, { spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0 });
    return {
      ...totals,
      ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : 0,
      avgCpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
      costPerConversion: totals.conversions > 0 ? totals.spend / totals.conversions : 0,
      conversionRate: totals.clicks > 0 ? totals.conversions / totals.clicks : 0,
      roas: totals.spend > 0 ? totals.conversionValue / totals.spend : 0,
      campaignCount: campaigns.length,
    };
  }, [campaigns]);

  const handleExportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      customer: selectedCustomer,
      rangeDays: days,
      overview,
      campaigns,
      adGroups,
      keywords,
      searchTerms,
      ads: adsList,
      assets,
      recommendations,
      conversions,
      devices,
      locations,
      dayHour,
      audience,
      auctionInsights,
      quality,
      changeHistory,
      diagnostics,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `google-ads-${selectedCustomerId || 'unknown'}-${days}d-${stamp}.json`;
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
    setDevTokenMissing(false);
    try {
      const rows = await googleAdsService.listConnectedCustomers();
      setConnectedCustomers(rows);
      if (rows.length > 0) {
        const last = localStorage.getItem('gmb_google_ads_customer_id');
        const match = last && rows.find(r => r.customerId === last);
        setSelectedCustomerId(match ? match.customerId : rows[0].customerId);
        setNeedsCustomerSelection(false);
      } else {
        setSelectedCustomerId(null);
        setNeedsCustomerSelection(true);
      }
    } catch (e) {
      const status = e.response?.status;
      const code = e.response?.data?.code;
      if (code === 'DEVELOPER_TOKEN_MISSING' || status === 503) setDevTokenMissing(true);
      if (status === 403 && e.response?.data?.needsReauth) setNeedsReauth(true);
      setError(e.response?.data?.error || e.message || 'Failed to load Google Ads');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReports = useCallback(async (customerId, rangeDays, filterCampaignId) => {
    if (!customerId) return;
    setLoadingReports(true);
    setError('');
    try {
      // Fan out — each endpoint is independent so we parallelize the whole set.
      // Campaign filter is applied where it makes sense (campaign, ad_group,
      // keyword_view, search_term_view, ad_group_ad, campaign_asset,
      // geographic_view, age_range_view, gender_view, quality). Devices,
      // day/hour, and conversions are FROM customer resources that don't
      // support a campaign WHERE clause — those tabs will always show
      // customer-wide numbers regardless of the campaign filter.
      const [
        cs, ag, kw, st, adResp, ast, rec, conv, dv, loc, dh, aud, ai, ql, ch, diag,
      ] = await Promise.all([
        googleAdsService.getCampaigns(customerId, rangeDays, filterCampaignId),
        googleAdsService.getAdGroups(customerId, rangeDays, filterCampaignId),
        googleAdsService.getKeywords(customerId, rangeDays, filterCampaignId),
        googleAdsService.getSearchTerms(customerId, rangeDays, filterCampaignId),
        googleAdsService.getAds(customerId, rangeDays, filterCampaignId),
        googleAdsService.getAssets(customerId, rangeDays, filterCampaignId),
        googleAdsService.getRecommendations(customerId),
        googleAdsService.getConversions(customerId, rangeDays),
        googleAdsService.getDevices(customerId, rangeDays),
        googleAdsService.getLocations(customerId, rangeDays, filterCampaignId),
        googleAdsService.getDayHour(customerId, rangeDays),
        googleAdsService.getAudience(customerId, rangeDays, filterCampaignId),
        googleAdsService.getAuctionInsights(customerId, rangeDays, filterCampaignId),
        googleAdsService.getQuality(customerId, rangeDays, filterCampaignId),
        googleAdsService.getChangeHistory(customerId, rangeDays),
        googleAdsService.getDiagnostics(customerId, rangeDays, filterCampaignId),
      ]);
      setCampaigns(cs.campaigns || []);
      // Keep the campaign-picker options in sync with the *unfiltered* campaign
      // list. When a filter is active, cs.campaigns is scoped to a single
      // campaign — don't clobber the dropdown or the user can never switch
      // back to another one. We refresh options only when no filter is set.
      if (!filterCampaignId) {
        setAllCampaignOptions(
          (cs.campaigns || []).map(c => ({
            id: c.campaignId,
            name: c.name || `Campaign ${c.campaignId}`,
            status: c.status,
          }))
        );
      }
      setAdGroups(ag.adGroups || []);
      setKeywords(kw.keywords || []);
      setSearchTerms(st.searchTerms || []);
      setAdsList(adResp.ads || []);
      setAssets(ast.assets || []);
      setRecommendations(rec.recommendations || []);
      setConversions(conv.conversions || []);
      setDevices(dv.devices || []);
      setLocations(loc.locations || []);
      setDayHour(dh.dayHour || []);
      setAudience(aud.audience || { ageRanges: [], genders: [] });
      setAuctionInsights(ai.auctionInsights || []);
      setQuality(ql.quality || []);
      setChangeHistory(ch.changeHistory && typeof ch.changeHistory === 'object' && !Array.isArray(ch.changeHistory)
        ? {
            events: ch.changeHistory.events || [],
            summary: ch.changeHistory.summary || [],
            caps: ch.changeHistory.caps || null,
            requestedDays: ch.changeHistory.requestedDays || null,
            unavailableBeyondDays: ch.changeHistory.unavailableBeyondDays || null,
          }
        : { events: Array.isArray(ch.changeHistory) ? ch.changeHistory : [], summary: [], caps: null, requestedDays: null, unavailableBeyondDays: null });
      setDiagnostics(diag.diagnostics || null);
    } catch (err) {
      const status = err.response?.status;
      const code = err.response?.data?.code;
      if (code === 'DEVELOPER_TOKEN_MISSING' || status === 503) setDevTokenMissing(true);
      if (status === 403 && err.response?.data?.needsReauth) setNeedsReauth(true);
      if (status === 400 && err.response?.data?.needsCustomerSelection) setNeedsCustomerSelection(true);
      setError(err.response?.data?.error || err.message || 'Failed to load Google Ads data');
    } finally {
      setLoadingReports(false);
    }
  }, []);

  useEffect(() => {
    loadConnected();
  }, [loadConnected]);

  useEffect(() => {
    if (selectedCustomerId) {
      localStorage.setItem('gmb_google_ads_customer_id', selectedCustomerId);
      loadReports(selectedCustomerId, days, campaignId);
    }
  }, [selectedCustomerId, days, campaignId, loadReports]);

  // When the customer or date range changes the underlying campaign list can
  // change too — a campaign that existed in the last 30d might not exist in
  // the last 7d. Reset the filter so we don't stay stuck on a stale id.
  useEffect(() => {
    setCampaignId(null);
  }, [selectedCustomerId]);

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Megaphone className="h-6 w-6 text-primary-600" />
            Google Ads
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Read-only campaign diagnostics — no bid changes, no edits.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {connectedCustomers.length > 0 && (
            <CustomerSelector
              customers={connectedCustomers}
              value={selectedCustomerId}
              onChange={setSelectedCustomerId}
            />
          )}
          <DayRangeSelector value={days} onChange={setDays} />
          {allCampaignOptions.length > 0 && (
            <CampaignFilter
              value={campaignId}
              onChange={setCampaignId}
              options={allCampaignOptions}
            />
          )}
          <button
            onClick={() => selectedCustomerId && loadReports(selectedCustomerId, days, campaignId)}
            disabled={!selectedCustomerId || loadingReports}
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
            {connectedCustomers.length ? 'Add account' : 'Connect account'}
          </button>
        </div>
      </div>

      {devTokenMissing && <DeveloperTokenMissing />}
      {needsReauth && !devTokenMissing && <NeedsReauthBanner />}
      {error && !needsReauth && !devTokenMissing && (
        <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : needsCustomerSelection ? (
        <EmptyState onConnect={() => setPickerOpen(true)} />
      ) : devTokenMissing ? null : (
        <>
          {selectedCustomer && (
            <p className="text-xs text-gray-500 mb-4">
              Customer: <span className="font-medium text-gray-700">{selectedCustomer.descriptiveName}</span>{' '}
              <span className="text-gray-400">({selectedCustomer.customerId})</span>
              {selectedCustomer.managerCustomerId && (
                <> · <span className="text-gray-500">via manager {selectedCustomer.managerCustomerId}</span></>
              )}
              {selectedCustomer.currencyCode && (
                <> · <span className="text-gray-500">{selectedCustomer.currencyCode}</span></>
              )}
              {selectedCustomer.timeZone && (
                <> · <span className="text-gray-500">{selectedCustomer.timeZone}</span></>
              )}
            </p>
          )}

          <SectionTabs value={activeSection} onChange={setActiveSection} />

          <div className="mt-6">
            {activeSection === 'overview'        && <OverviewCards overview={overview} loading={loadingReports} currency={currency} />}
            {activeSection === 'diagnostics'     && <DiagnosticsView diagnostics={diagnostics} loading={loadingReports} currency={currency} />}
            {activeSection === 'campaigns'       && <CampaignsTable rows={campaigns} loading={loadingReports} currency={currency} />}
            {activeSection === 'adGroups'        && <AdGroupsTable rows={adGroups} loading={loadingReports} currency={currency} />}
            {activeSection === 'keywords'        && <KeywordsTable rows={keywords} loading={loadingReports} currency={currency} />}
            {activeSection === 'searchTerms'     && <SearchTermsTable rows={searchTerms} loading={loadingReports} currency={currency} />}
            {activeSection === 'ads'             && <AdsList rows={adsList} loading={loadingReports} currency={currency} />}
            {activeSection === 'assets'          && <AssetsTable rows={assets} loading={loadingReports} currency={currency} />}
            {activeSection === 'recommendations' && <RecommendationsView rows={recommendations} loading={loadingReports} currency={currency} />}
            {activeSection === 'conversions'     && <ConversionsTable rows={conversions} loading={loadingReports} currency={currency} />}
            {activeSection === 'devices'         && <DevicesView rows={devices} loading={loadingReports} currency={currency} />}
            {activeSection === 'locations'       && <LocationsTable rows={locations} loading={loadingReports} currency={currency} />}
            {activeSection === 'dayHour'         && <DayHourHeatmap rows={dayHour} loading={loadingReports} />}
            {activeSection === 'audience'        && <AudienceView data={audience} loading={loadingReports} currency={currency} />}
            {activeSection === 'auctionInsights' && <AuctionInsightsTable rows={auctionInsights} loading={loadingReports} />}
            {activeSection === 'quality'         && <QualityTable rows={quality} loading={loadingReports} />}
            {activeSection === 'changeHistory'   && <ChangeHistoryTable data={changeHistory} loading={loadingReports} />}
          </div>
        </>
      )}

      {pickerOpen && (
        <CustomerPickerModal
          user={user}
          onClose={() => setPickerOpen(false)}
          onConnected={async (row) => {
            setPickerOpen(false);
            await loadConnected();
            const cid = row?.metadata?.customer_id;
            if (cid) setSelectedCustomerId(cid);
          }}
        />
      )}
    </div>
  );
};

// ---------- Sub-components ----------

const CustomerSelector = ({ customers, value, onChange }) => (
  <div className="inline-flex items-center gap-2 bg-white border border-gray-300 rounded-md px-3 py-2">
    <Link2 className="h-4 w-4 text-gray-400" />
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      className="text-sm text-gray-700 bg-transparent border-0 focus:ring-0 focus:outline-none pr-6"
    >
      {customers.map(c => (
        <option key={c.customerId} value={c.customerId}>
          {c.descriptiveName} — {c.customerId}
          {c.ownerEmail ? ` (${c.ownerEmail})` : ''}
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
          value === r.value ? 'bg-primary-600 text-white' : 'text-gray-700 hover:bg-gray-50'
        }`}
      >
        {r.label}
      </button>
    ))}
  </div>
);

const CampaignFilter = ({ value, onChange, options }) => (
  <select
    value={value || ''}
    onChange={e => onChange(e.target.value || null)}
    className="border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-700 bg-white hover:bg-gray-50 max-w-xs truncate"
    title={value ? `Filtering by campaign ${value}` : 'All campaigns'}
  >
    <option value="">All campaigns</option>
    {options.map(c => (
      <option key={c.id} value={c.id}>
        {c.name}{c.status && c.status !== 'ENABLED' ? ` · ${c.status.toLowerCase()}` : ''}
      </option>
    ))}
  </select>
);

const SectionTabs = ({ value, onChange }) => (
  <div className="border-b border-gray-200 overflow-x-auto">
    <div className="flex gap-1 min-w-max">
      {SECTIONS.map(s => (
        <button
          key={s.key}
          onClick={() => onChange(s.key)}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${
            value === s.key
              ? 'border-primary-600 text-primary-700'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-200'
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  </div>
);

const DeveloperTokenMissing = () => (
  <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-md">
    <div className="flex items-start gap-3">
      <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-medium text-amber-900">Google Ads developer token not configured</p>
        <p className="text-sm text-amber-800 mt-1">
          The Google Ads API requires a developer token in addition to OAuth. Apply for one in
          Google Ads → <strong>Tools & Settings → API Center</strong>, then set
          <code className="text-xs px-1 py-0.5 bg-amber-100 rounded mx-1">GOOGLE_ADS_DEVELOPER_TOKEN</code>
          on the backend. Test-account tokens are instant; basic-access tokens take 1-2 business days for review.
        </p>
      </div>
    </div>
  </div>
);

const NeedsReauthBanner = () => {
  const { loginForBusiness } = useAuth();
  return (
    <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-md">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-medium text-amber-900">Google Ads permission missing</p>
          <p className="text-sm text-amber-800 mt-1">
            Your Google connection doesn't include the <code className="text-xs px-1 py-0.5 bg-amber-100 rounded">adwords</code> scope.
            Reconnect Google Business to grant it.
          </p>
          <button
            onClick={() => loginForBusiness()}
            className="mt-2 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded hover:bg-primary-700"
          >
            Reconnect Google
          </button>
        </div>
      </div>
    </div>
  );
};

const EmptyState = ({ onConnect }) => (
  <div className="text-center py-16 px-4 border-2 border-dashed border-gray-200 rounded-lg bg-white">
    <Megaphone className="h-10 w-10 text-gray-400 mx-auto mb-3" />
    <h3 className="text-base font-medium text-gray-900">No Google Ads account connected</h3>
    <p className="text-sm text-gray-500 mt-1 mb-4">
      Connect a Google Ads customer to see campaigns, keywords, search terms, and diagnostics.
    </p>
    <button
      onClick={onConnect}
      className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
    >
      <Plus className="h-4 w-4" />
      Connect Google Ads account
    </button>
  </div>
);

const OverviewCards = ({ overview, loading, currency }) => {
  const cards = [
    { key: 'spend',        label: 'Spend',           icon: DollarSign,        value: fmtMoney(overview?.spend, currency) },
    { key: 'impressions',  label: 'Impressions',     icon: TrendingUp,        value: fmtInt(overview?.impressions) },
    { key: 'clicks',       label: 'Clicks',          icon: MousePointerClick, value: fmtInt(overview?.clicks) },
    { key: 'ctr',          label: 'CTR',             icon: TrendingUp,        value: fmtPercent(overview?.ctr) },
    { key: 'cpc',          label: 'Avg CPC',         icon: DollarSign,        value: fmtMoney(overview?.avgCpc, currency) },
    { key: 'conv',         label: 'Conversions',     icon: Target,            value: fmtFixed(overview?.conversions) },
    { key: 'cpa',          label: 'Cost / Conv.',    icon: DollarSign,        value: fmtMoney(overview?.costPerConversion, currency) },
    { key: 'convRate',     label: 'Conv. Rate',      icon: TrendingUp,        value: fmtPercent(overview?.conversionRate) },
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

const TableEmpty = ({ msg = 'No data for this date range.' }) => (
  <div className="p-6 text-center text-sm text-gray-500">{msg}</div>
);
const TableLoading = () => <div className="p-6 text-center text-sm text-gray-400">Loading…</div>;

const Th = ({ children, align = 'left' }) => (
  <th className={`px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide ${align === 'right' ? 'text-right' : 'text-left'}`}>
    {children}
  </th>
);
const Td = ({ children, align = 'left', className = '' }) => (
  <td className={`px-3 py-2 text-sm text-gray-700 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
    {children}
  </td>
);

const Panel = ({ children }) => (
  <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">{children}</div>
);

const severityColor = (s) => {
  if (s === 'high') return 'bg-red-50 border-red-200 text-red-800';
  if (s === 'medium') return 'bg-amber-50 border-amber-200 text-amber-800';
  return 'bg-blue-50 border-blue-200 text-blue-800';
};

const DiagnosticsView = ({ diagnostics, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!diagnostics) return <TableEmpty />;
  const issues = diagnostics.issues || [];
  return (
    <div>
      <div className="mb-4 grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
        {Object.entries(diagnostics.counts || {}).map(([k, v]) => (
          <div key={k} className="bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
            <div className="text-gray-500 uppercase tracking-wide">{k}</div>
            <div className="font-semibold text-gray-900">{fmtInt(v)}</div>
          </div>
        ))}
      </div>

      {issues.length === 0 ? (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-800">
          No issues detected. Nice — the account looks clean for the selected range.
        </div>
      ) : (
        <div className="space-y-3">
          {issues.map((issue, i) => (
            <div key={i} className={`p-4 rounded border ${severityColor(issue.severity)}`}>
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold">{issue.title}</p>
                  <div className="text-xs mt-1 space-x-3">
                    {issue.severity && <span className="uppercase tracking-wide">{issue.severity}</span>}
                    {issue.count != null && <span>{issue.count} item{issue.count === 1 ? '' : 's'}</span>}
                    {issue.value != null && <span>{issue.value}</span>}
                    {issue.campaigns != null && <span>{issue.campaigns} campaign{issue.campaigns === 1 ? '' : 's'}</span>}
                  </div>
                  {issue.guidance && (
                    <p className="text-xs mt-2 opacity-90">{issue.guidance}</p>
                  )}
                  {issue.details && issue.details.length > 0 && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer opacity-80">Show details</summary>
                      <pre className="mt-2 p-2 bg-white/60 rounded text-[11px] whitespace-pre-wrap font-mono overflow-x-auto">
{JSON.stringify(issue.details, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const CampaignsTable = ({ rows, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  return (
    <Panel>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr>
              <Th>Campaign</Th>
              <Th>Status</Th>
              <Th>Channel</Th>
              <Th align="right">Budget</Th>
              <Th align="right">Spend</Th>
              <Th align="right">Impr.</Th>
              <Th align="right">Clicks</Th>
              <Th align="right">CTR</Th>
              <Th align="right">Avg CPC</Th>
              <Th align="right">Conv.</Th>
              <Th align="right">CPA</Th>
              <Th align="right">Conv. Rate</Th>
              <Th align="right">SIS</Th>
              <Th align="right">Lost IS (Budget)</Th>
              <Th align="right">Lost IS (Rank)</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="font-medium text-gray-900">{r.name}</Td>
                <Td className="text-xs">{r.status}</Td>
                <Td className="text-xs">{r.channel}</Td>
                <Td align="right">{fmtMoney(r.budget, currency)}</Td>
                <Td align="right">{fmtMoney(r.spend, currency)}</Td>
                <Td align="right">{fmtInt(r.impressions)}</Td>
                <Td align="right">{fmtInt(r.clicks)}</Td>
                <Td align="right">{fmtPercent(r.ctr)}</Td>
                <Td align="right">{fmtMoney(r.avgCpc, currency)}</Td>
                <Td align="right">{fmtFixed(r.conversions)}</Td>
                <Td align="right">{fmtMoney(r.costPerConversion, currency)}</Td>
                <Td align="right">{fmtPercent(r.conversionRate)}</Td>
                <Td align="right">{fmtPercent(r.searchImpressionShare)}</Td>
                <Td align="right">{fmtPercent(r.lostIsBudget)}</Td>
                <Td align="right">{fmtPercent(r.lostIsRank)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const AdGroupsTable = ({ rows, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  return (
    <Panel>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr>
              <Th>Ad Group</Th>
              <Th>Campaign</Th>
              <Th>Status</Th>
              <Th align="right">Spend</Th>
              <Th align="right">Impr.</Th>
              <Th align="right">Clicks</Th>
              <Th align="right">CTR</Th>
              <Th align="right">CPC</Th>
              <Th align="right">Conv.</Th>
              <Th align="right">CPA</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="font-medium text-gray-900">{r.name}</Td>
                <Td className="text-xs">{r.campaign}</Td>
                <Td className="text-xs">{r.status}</Td>
                <Td align="right">{fmtMoney(r.spend, currency)}</Td>
                <Td align="right">{fmtInt(r.impressions)}</Td>
                <Td align="right">{fmtInt(r.clicks)}</Td>
                <Td align="right">{fmtPercent(r.ctr)}</Td>
                <Td align="right">{fmtMoney(r.cpc, currency)}</Td>
                <Td align="right">{fmtFixed(r.conversions)}</Td>
                <Td align="right">{fmtMoney(r.costPerConversion, currency)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const KeywordsTable = ({ rows, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  return (
    <Panel>
      <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <Th>Keyword</Th>
              <Th>Match Type</Th>
              <Th>Ad Group</Th>
              <Th align="right">Clicks</Th>
              <Th align="right">Impr.</Th>
              <Th align="right">CTR</Th>
              <Th align="right">Avg CPC</Th>
              <Th align="right">Cost</Th>
              <Th align="right">Conv.</Th>
              <Th align="right">QS</Th>
              <Th>Expected CTR</Th>
              <Th>Ad Rel.</Th>
              <Th>LP Exp.</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="font-medium text-gray-900">{r.keyword}</Td>
                <Td className="text-xs">{r.matchType}</Td>
                <Td className="text-xs">{r.adGroup}</Td>
                <Td align="right">{fmtInt(r.clicks)}</Td>
                <Td align="right">{fmtInt(r.impressions)}</Td>
                <Td align="right">{fmtPercent(r.ctr)}</Td>
                <Td align="right">{fmtMoney(r.avgCpc, currency)}</Td>
                <Td align="right">{fmtMoney(r.cost, currency)}</Td>
                <Td align="right">{fmtFixed(r.conversions)}</Td>
                <Td align="right">{r.qualityScore ?? '—'}</Td>
                <Td className="text-xs">{r.expectedCtr || '—'}</Td>
                <Td className="text-xs">{r.creativeQualityScore || '—'}</Td>
                <Td className="text-xs">{r.landingPageExperience || '—'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const SearchTermsTable = ({ rows, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  return (
    <Panel>
      <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <Th>Search Term</Th>
              <Th>Matched Keyword</Th>
              <Th>Match Type</Th>
              <Th>Status</Th>
              <Th align="right">Clicks</Th>
              <Th align="right">Cost</Th>
              <Th align="right">Conv.</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="font-medium text-gray-900 flex items-center gap-1.5">
                  <Search className="h-3 w-3 text-gray-400" />
                  {r.searchTerm}
                </Td>
                <Td className="text-xs">{r.matchedKeyword}</Td>
                <Td className="text-xs">{r.matchType}</Td>
                <Td className="text-xs">{r.status}</Td>
                <Td align="right">{fmtInt(r.clicks)}</Td>
                <Td align="right">{fmtMoney(r.cost, currency)}</Td>
                <Td align="right">{fmtFixed(r.conversions)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const AdsList = ({ rows, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  const strengthBadge = (s) => {
    const map = {
      EXCELLENT: 'bg-emerald-100 text-emerald-800',
      GOOD:      'bg-blue-100 text-blue-800',
      AVERAGE:   'bg-amber-100 text-amber-800',
      POOR:      'bg-red-100 text-red-800',
    };
    const cls = map[s] || 'bg-gray-100 text-gray-800';
    return <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${cls}`}>{s || 'UNKNOWN'}</span>;
  };
  return (
    <div className="space-y-3">
      {rows.map(a => (
        <div key={a.adId} className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-start justify-between mb-2">
            <div>
              <p className="text-sm font-medium text-gray-900">{a.campaign} · {a.adGroup}</p>
              <p className="text-xs text-gray-500">Ad ID {a.adId} · {a.type} · {a.status}</p>
            </div>
            {strengthBadge(a.adStrength)}
          </div>
          {a.headlines?.length > 0 && (
            <div className="mt-2">
              <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-1">Headlines ({a.headlines.length})</p>
              <ul className="text-xs text-gray-700 space-y-0.5">
                {a.headlines.slice(0, 15).map((h, i) => <li key={i}>· {h}</li>)}
              </ul>
            </div>
          )}
          {a.descriptions?.length > 0 && (
            <div className="mt-2">
              <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-1">Descriptions ({a.descriptions.length})</p>
              <ul className="text-xs text-gray-700 space-y-0.5">
                {a.descriptions.slice(0, 4).map((d, i) => <li key={i}>· {d}</li>)}
              </ul>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-600">
            <span>Impr {fmtInt(a.impressions)}</span>
            <span>Clicks {fmtInt(a.clicks)}</span>
            <span>CTR {fmtPercent(a.ctr)}</span>
            <span>Cost {fmtMoney(a.cost, currency)}</span>
            <span>Conv {fmtFixed(a.conversions)}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

const AssetsTable = ({ rows, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  return (
    <Panel>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr>
              <Th>Type</Th>
              <Th>Text</Th>
              <Th>Campaign</Th>
              <Th align="right">Impr.</Th>
              <Th align="right">Clicks</Th>
              <Th align="right">CTR</Th>
              <Th align="right">Cost</Th>
              <Th align="right">Conv.</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="text-xs uppercase">{r.type}</Td>
                <Td>{truncate(r.text, 60)}</Td>
                <Td className="text-xs">{r.campaign}</Td>
                <Td align="right">{fmtInt(r.impressions)}</Td>
                <Td align="right">{fmtInt(r.clicks)}</Td>
                <Td align="right">{fmtPercent(r.ctr)}</Td>
                <Td align="right">{fmtMoney(r.cost, currency)}</Td>
                <Td align="right">{fmtFixed(r.conversions)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const RecommendationsView = ({ rows, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) {
    return <TableEmpty msg="No recommendations from Google right now." />;
  }
  const active = rows.filter(r => !r.dismissed);
  return (
    <div className="space-y-3">
      {active.map((r, i) => (
        <div key={i} className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-start gap-2">
            <Lightbulb className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">{r.type?.replace(/_/g, ' ')}</p>
              <p className="text-xs text-gray-500 mt-1">{r.resourceName}</p>
              <div className="mt-2 grid grid-cols-4 gap-3 text-xs">
                <div>
                  <p className="text-gray-500 uppercase tracking-wide">Δ Impr.</p>
                  <p className="font-medium text-gray-900">+{fmtInt(r.potential.impressions - r.base.impressions)}</p>
                </div>
                <div>
                  <p className="text-gray-500 uppercase tracking-wide">Δ Clicks</p>
                  <p className="font-medium text-gray-900">+{fmtInt(r.potential.clicks - r.base.clicks)}</p>
                </div>
                <div>
                  <p className="text-gray-500 uppercase tracking-wide">Δ Cost</p>
                  <p className="font-medium text-gray-900">{fmtMoney(r.potential.cost - r.base.cost, currency)}</p>
                </div>
                <div>
                  <p className="text-gray-500 uppercase tracking-wide">Δ Conv.</p>
                  <p className="font-medium text-gray-900">+{fmtFixed(r.potential.conversions - r.base.conversions)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

const ConversionsTable = ({ rows, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty msg="No conversion actions configured." />;
  return (
    <Panel>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th>Category</Th>
              <Th>Type</Th>
              <Th>Primary</Th>
              <Th>Counting</Th>
              <Th align="right">Click Window (d)</Th>
              <Th align="right">Conv.</Th>
              <Th align="right">All Conv.</Th>
              <Th align="right">Value</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="font-medium text-gray-900 flex items-center gap-1.5">
                  <ClipboardCheck className="h-3 w-3 text-gray-400" />
                  {r.name}
                </Td>
                <Td className="text-xs">{r.status}</Td>
                <Td className="text-xs">{r.category}</Td>
                <Td className="text-xs">{r.type}</Td>
                <Td className="text-xs">{r.primary ? 'Yes' : 'No'}</Td>
                <Td className="text-xs">{r.countingType}</Td>
                <Td align="right">{r.clickThroughLookbackDays}</Td>
                <Td align="right">{fmtFixed(r.conversions)}</Td>
                <Td align="right">{fmtFixed(r.allConversions)}</Td>
                <Td align="right">{fmtMoney(r.conversionValue, currency)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const DevicesView = ({ rows, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  const iconFor = (d) => {
    const key = String(d || '').toLowerCase();
    if (key.includes('mobile')) return Smartphone;
    if (key.includes('tablet')) return Tablet;
    return Monitor;
  };
  const total = rows.reduce((s, r) => s + Number(r.impressions || 0), 0) || 1;
  return (
    <Panel>
      <div className="p-4 space-y-4">
        {rows.map(r => {
          const Icon = iconFor(r.device);
          const pct = Math.round((Number(r.impressions || 0) / total) * 100);
          return (
            <div key={r.device}>
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 text-gray-700">
                  <Icon className="h-4 w-4 text-gray-400" />
                  <span className="capitalize">{String(r.device || '').toLowerCase()}</span>
                </div>
                <div className="text-gray-500 text-xs space-x-3">
                  <span>Spend {fmtMoney(r.spend, currency)}</span>
                  <span>Clicks {fmtInt(r.clicks)}</span>
                  <span>Conv {fmtFixed(r.conversions)}</span>
                  <span>CPA {fmtMoney(r.cpa, currency)}</span>
                  <span>Conv Rate {fmtPercent(r.conversionRate)}</span>
                </div>
              </div>
              <div className="mt-1 h-2 bg-gray-100 rounded">
                <div className="h-2 bg-primary-500 rounded" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
};

const LocationsTable = ({ rows, loading, currency }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  return (
    <Panel>
      <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <Th>Country ID</Th>
              <Th>Type</Th>
              <Th>Campaign</Th>
              <Th align="right">Impr.</Th>
              <Th align="right">Clicks</Th>
              <Th align="right">CTR</Th>
              <Th align="right">Cost</Th>
              <Th align="right">Conv.</Th>
              <Th align="right">CPA</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="font-mono text-xs flex items-center gap-1.5">
                  <MapPin className="h-3 w-3 text-gray-400" />
                  {r.countryCriterionId}
                </Td>
                <Td className="text-xs">{r.locationType}</Td>
                <Td className="text-xs">{r.campaign}</Td>
                <Td align="right">{fmtInt(r.impressions)}</Td>
                <Td align="right">{fmtInt(r.clicks)}</Td>
                <Td align="right">{fmtPercent(r.ctr)}</Td>
                <Td align="right">{fmtMoney(r.cost, currency)}</Td>
                <Td align="right">{fmtFixed(r.conversions)}</Td>
                <Td align="right">{fmtMoney(r.costPerConversion, currency)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const DAYS_ORDER = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

const DayHourHeatmap = ({ rows, loading }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) return <TableEmpty />;
  // Build a day → hour → { clicks, cost, conversions } map.
  const grid = {};
  DAYS_ORDER.forEach(d => { grid[d] = {}; });
  let maxClicks = 0;
  rows.forEach(r => {
    if (!grid[r.dayOfWeek]) grid[r.dayOfWeek] = {};
    grid[r.dayOfWeek][r.hour] = r;
    if (Number(r.clicks || 0) > maxClicks) maxClicks = Number(r.clicks);
  });
  const bg = (v) => {
    if (!v || v === 0) return 'bg-gray-50';
    const intensity = Math.min(1, v / (maxClicks || 1));
    const alpha = Math.max(0.1, intensity);
    return '';
  };
  return (
    <Panel>
      <div className="overflow-x-auto p-3">
        <table className="min-w-full text-xs">
          <thead>
            <tr>
              <th className="p-1 text-left text-gray-500"><Clock className="h-3 w-3 inline mr-1" />Day / Hour</th>
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="p-1 text-center text-gray-500 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS_ORDER.map(d => (
              <tr key={d}>
                <td className="p-1 text-gray-700 font-medium">{d.slice(0, 3)}</td>
                {Array.from({ length: 24 }, (_, h) => {
                  const cell = grid[d]?.[h];
                  const clicks = Number(cell?.clicks || 0);
                  const intensity = Math.min(1, clicks / (maxClicks || 1));
                  const bgColor = clicks > 0
                    ? `rgba(59, 130, 246, ${0.15 + intensity * 0.7})`
                    : 'rgba(243, 244, 246, 1)';
                  return (
                    <td
                      key={h}
                      className="p-1 text-center text-[10px] text-gray-700"
                      style={{ backgroundColor: bgColor }}
                      title={cell ? `${d} ${h}:00 · clicks ${cell.clicks} · conv ${cell.conversions}` : ''}
                    >
                      {clicks > 0 ? fmtInt(clicks) : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const AudienceView = ({ data, loading, currency }) => {
  if (loading) return <TableLoading />;
  const { ageRanges = [], genders = [] } = data || {};
  if (ageRanges.length === 0 && genders.length === 0) {
    return <TableEmpty msg="No audience data. Add age/gender targeting to your campaigns to see this." />;
  }
  const renderTable = (rows, dimKey, dimLabel) => (
    <Panel>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr>
              <Th>{dimLabel}</Th>
              <Th>Ad Group</Th>
              <Th align="right">Impr.</Th>
              <Th align="right">Clicks</Th>
              <Th align="right">CTR</Th>
              <Th align="right">Cost</Th>
              <Th align="right">Conv.</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="text-xs font-medium">{r[dimKey] || '—'}</Td>
                <Td className="text-xs">{r.adGroup}</Td>
                <Td align="right">{fmtInt(r.impressions)}</Td>
                <Td align="right">{fmtInt(r.clicks)}</Td>
                <Td align="right">{fmtPercent(r.ctr)}</Td>
                <Td align="right">{fmtMoney(r.cost, currency)}</Td>
                <Td align="right">{fmtFixed(r.conversions)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
  return (
    <div className="space-y-4">
      {ageRanges.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <Users className="h-3 w-3" /> Age Ranges
          </p>
          {renderTable(ageRanges, 'ageRange', 'Age')}
        </div>
      )}
      {genders.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <Users className="h-3 w-3" /> Genders
          </p>
          {renderTable(genders, 'gender', 'Gender')}
        </div>
      )}
    </div>
  );
};

const AuctionInsightsTable = ({ rows, loading }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) {
    return <TableEmpty msg="Auction insights not available for this account or range." />;
  }
  return (
    <Panel>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr>
              <Th>Campaign</Th>
              <Th align="right">Search IS</Th>
              <Th align="right">Top IS</Th>
              <Th align="right">Abs. Top IS</Th>
              <Th align="right">Lost IS (Rank)</Th>
              <Th align="right">Lost IS (Budget)</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="font-medium text-gray-900">{r.campaign}</Td>
                <Td align="right">{fmtPercent(r.searchImpressionShare)}</Td>
                <Td align="right">{fmtPercent(r.searchTopImpressionShare)}</Td>
                <Td align="right">{fmtPercent(r.searchAbsoluteTopImpressionShare)}</Td>
                <Td align="right">{fmtPercent(r.searchRankLostImpressionShare)}</Td>
                <Td align="right">{fmtPercent(r.searchBudgetLostImpressionShare)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const QualityTable = ({ rows, loading }) => {
  if (loading) return <TableLoading />;
  if (!rows || rows.length === 0) {
    return <TableEmpty msg="No keywords with a Quality Score in this range." />;
  }
  const qsColor = (n) => {
    if (n == null) return 'text-gray-400';
    if (n >= 8) return 'text-emerald-700';
    if (n >= 5) return 'text-amber-700';
    return 'text-red-700';
  };
  return (
    <Panel>
      <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <Th>Keyword</Th>
              <Th>Match Type</Th>
              <Th>Ad Group</Th>
              <Th align="right">QS</Th>
              <Th>Expected CTR</Th>
              <Th>Ad Relevance</Th>
              <Th>LP Experience</Th>
              <Th align="right">Impr.</Th>
              <Th align="right">Clicks</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="font-medium text-gray-900">{r.keyword}</Td>
                <Td className="text-xs">{r.matchType}</Td>
                <Td className="text-xs">{r.adGroup}</Td>
                <Td align="right" className={`font-semibold ${qsColor(r.qualityScore)}`}>{r.qualityScore ?? '—'}</Td>
                <Td className="text-xs">{r.expectedCtr || '—'}</Td>
                <Td className="text-xs">{r.creativeQualityScore || '—'}</Td>
                <Td className="text-xs">{r.landingPageExperience || '—'}</Td>
                <Td align="right">{fmtInt(r.impressions)}</Td>
                <Td align="right">{fmtInt(r.clicks)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const ChangeHistoryTable = ({ data, loading }) => {
  if (loading) return <TableLoading />;
  const events = data?.events || [];
  const summary = data?.summary || [];
  const requestedDays = data?.requestedDays || null;
  const unavailableBeyondDays = data?.unavailableBeyondDays || null;
  const hasSummary = summary.length > 0 || (requestedDays && requestedDays > 30);

  return (
    <div className="space-y-4">
      <div className="p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900">
        <p className="font-medium mb-1">Google Ads API change-history windows</p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li><strong>Last 30 days</strong> — detailed events (who changed which field, per row).</li>
          <li><strong>Last 90 days</strong> — resource-level summary (which resources changed and when, no per-field detail).</li>
          {unavailableBeyondDays && (
            <li className="text-blue-800"><strong>Beyond {unavailableBeyondDays} days</strong> — not exposed by the Google Ads API. The Web UI can show more; the API cannot.</li>
          )}
        </ul>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900">Detailed events (last 30 days)</h3>
          <span className="text-xs text-gray-500">{events.length} row{events.length === 1 ? '' : 's'}</span>
        </div>
        {events.length === 0 ? (
          <TableEmpty msg="No detailed changes in the last 30 days." />
        ) : (
          <Panel>
            <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <Th>When</Th>
                    <Th>User</Th>
                    <Th>Client</Th>
                    <Th>Resource</Th>
                    <Th>Op</Th>
                    <Th>Fields</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {events.map((r, i) => (
                    <tr key={i}>
                      <Td className="text-xs font-mono flex items-center gap-1.5">
                        <History className="h-3 w-3 text-gray-400" />
                        {r.changeDateTime}
                      </Td>
                      <Td className="text-xs">{r.userEmail || '—'}</Td>
                      <Td className="text-xs">{r.clientType}</Td>
                      <Td className="text-xs">{r.resourceType}</Td>
                      <Td className="text-xs">{r.operation}</Td>
                      <Td className="text-xs">{truncate(JSON.stringify(r.changedFields || ''), 60)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>

      {hasSummary && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-900">Resource-level summary (30–90 days)</h3>
            <span className="text-xs text-gray-500">{summary.length} row{summary.length === 1 ? '' : 's'}</span>
          </div>
          {summary.length === 0 ? (
            <TableEmpty msg="No resource-level changes in the 30–90 day window." />
          ) : (
            <Panel>
              <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
                <table className="min-w-full divide-y divide-gray-100">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <Th>Last change</Th>
                      <Th>Resource type</Th>
                      <Th>Status</Th>
                      <Th>Campaign</Th>
                      <Th>Ad group</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {summary.map((r, i) => (
                      <tr key={i}>
                        <Td className="text-xs font-mono flex items-center gap-1.5">
                          <History className="h-3 w-3 text-gray-400" />
                          {r.changeDateTime}
                        </Td>
                        <Td className="text-xs">{r.resourceType}</Td>
                        <Td className="text-xs">{r.resourceStatus}</Td>
                        <Td className="text-xs">{truncate(r.campaign || '—', 40)}</Td>
                        <Td className="text-xs">{truncate(r.adGroup || '—', 40)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
};

// ---------- Customer picker modal ----------

const CustomerPickerModal = ({ onClose, onConnected }) => {
  const { loginForBusiness } = useAuth();
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [needsReauth, setNeedsReauth] = useState(false);
  const [devTokenMissing, setDevTokenMissing] = useState(false);
  const [selecting, setSelecting] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const rows = await googleAdsService.listAvailableCustomers();
        setCustomers(rows);
      } catch (e) {
        const status = e.response?.status;
        const code = e.response?.data?.code;
        if (code === 'DEVELOPER_TOKEN_MISSING' || status === 503) setDevTokenMissing(true);
        if (status === 403 && e.response?.data?.needsReauth) setNeedsReauth(true);
        setErr(e.response?.data?.error || e.message || 'Failed to list customers');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSelect = async (c) => {
    setSelecting(c.customerId);
    setErr('');
    try {
      const row = await googleAdsService.selectCustomer({
        customerId: c.customerId,
        descriptiveName: c.descriptiveName,
        managerCustomerId: c.managerCustomerId || null,
        currencyCode: c.currencyCode,
        timeZone: c.timeZone,
        ownerGoogleId: c.ownerGoogleId,
        ownerEmail: c.ownerEmail,
      });
      onConnected(row);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed to save customer');
      setSelecting(null);
    }
  };

  const grouped = useMemo(() => {
    const map = new Map();
    customers.forEach(c => {
      const key = c.ownerEmail || c.ownerGoogleId || '__unknown__';
      if (!map.has(key)) map.set(key, { ownerEmail: c.ownerEmail, customers: [] });
      map.get(key).customers.push(c);
    });
    return Array.from(map.values());
  }, [customers]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Connect Google Ads account</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-gray-500">Loading customers…</p>
          ) : devTokenMissing ? (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
              <p className="font-medium">Google Ads developer token not configured on the server.</p>
              <p className="mt-1">
                Apply for a developer token in Google Ads → <strong>Tools & Settings → API Center</strong>,
                then set <code className="text-xs px-1 py-0.5 bg-amber-100 rounded">GOOGLE_ADS_DEVELOPER_TOKEN</code> on the backend.
              </p>
            </div>
          ) : needsReauth ? (
            <div>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800 mb-4">
                <p className="font-medium">Missing Google Ads (adwords) scope.</p>
                <p className="mt-1">Reconnect Google Business to grant the adwords scope.</p>
              </div>
              <button
                onClick={() => loginForBusiness()}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700"
              >
                Reconnect Google
              </button>
            </div>
          ) : customers.length === 0 ? (
            <div>
              <p className="text-sm text-gray-500 mb-4">
                No Google Ads accounts found on your Google account.
              </p>
              <button
                onClick={() => loginForBusiness()}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700"
              >
                Connect another Google account
              </button>
              {err && <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">{err}</div>}
            </div>
          ) : (
            <div>
              <div className="flex items-start justify-between gap-3 mb-4">
                <p className="text-sm text-gray-500">
                  Pick a customer to connect. You can connect multiple.
                </p>
                <button
                  onClick={() => loginForBusiness()}
                  className="flex-shrink-0 text-xs font-medium text-primary-600 hover:text-primary-700 whitespace-nowrap"
                >
                  + Add Google account
                </button>
              </div>
              {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800 mb-3">{err}</div>}
              <div className="space-y-4">
                {grouped.map(group => (
                  <div key={group.ownerEmail || 'unknown'}>
                    {group.ownerEmail && (
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                        {group.ownerEmail}
                      </p>
                    )}
                    <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md">
                      {group.customers.map(c => (
                        <li key={c.customerId} className="p-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">
                              {c.descriptiveName}
                              {c.manager && <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded uppercase font-semibold">Manager</span>}
                              {c.testAccount && <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded uppercase font-semibold">Test</span>}
                            </p>
                            <p className="text-xs text-gray-500">
                              Customer {c.customerId}
                              {c.currencyCode && ` · ${c.currencyCode}`}
                              {c.timeZone && ` · ${c.timeZone}`}
                            </p>
                          </div>
                          <button
                            onClick={() => handleSelect(c)}
                            disabled={!!selecting || c.manager}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-700 disabled:opacity-50"
                            title={c.manager ? 'Managers list only — pick a specific customer account under them.' : ''}
                          >
                            {selecting === c.customerId ? (
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

export default GoogleAds;
