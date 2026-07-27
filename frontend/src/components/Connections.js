import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Globe, Building2, Instagram, Facebook, LineChart, Megaphone, Bot, Search, Plus, Trash2, ExternalLink, X, Check, AlertCircle, RefreshCw, Sparkles } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import connectionsService from '../services/connectionsService';

const PROVIDER_META = {
  website: {
    label: 'Website',
    icon: Globe,
    color: 'text-emerald-600',
    bg: 'bg-emerald-50',
  },
  google_business: {
    // Displayed on existing connection cards. Named "Google Account" because
    // this OAuth grant now bundles Business Profile + Drive + Analytics +
    // Ads + Search Console scopes — it isn't Business-Profile-only.
    label: 'Google Account',
    icon: Building2,
    color: 'text-blue-600',
    bg: 'bg-blue-50',
  },
  google_analytics: {
    label: 'Google Analytics',
    icon: LineChart,
    color: 'text-orange-600',
    bg: 'bg-orange-50',
  },
  google_ads: {
    label: 'Google Ads',
    icon: Megaphone,
    color: 'text-purple-600',
    bg: 'bg-purple-50',
  },
  google_search_console: {
    label: 'Google Search Console',
    icon: Search,
    color: 'text-yellow-700',
    bg: 'bg-yellow-50',
  },
  instagram: {
    label: 'Instagram',
    icon: Instagram,
    color: 'text-pink-600',
    bg: 'bg-pink-50',
  },
  facebook: {
    label: 'Facebook',
    icon: Facebook,
    color: 'text-indigo-600',
    bg: 'bg-indigo-50',
  },
  openai_ads: {
    label: 'OpenAI Ads',
    icon: Bot,
    color: 'text-gray-900',
    bg: 'bg-gray-100',
  },
};

const Connections = () => {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const rows = await connectionsService.list();
      setConnections(rows);
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load connections');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Handle Meta OAuth callback redirect: /connections?meta_connected=1&pages=N&ig=N
  // (or ?meta_error=... on failure). Show a brief flash, then strip params.
  useEffect(() => {
    const metaConnected = searchParams.get('meta_connected');
    const metaError = searchParams.get('meta_error');
    const metaWarning = searchParams.get('meta_warning');
    if (metaConnected) {
      const pages = searchParams.get('pages') || '0';
      const ig = searchParams.get('ig') || '0';
      if (metaWarning === 'no_pages_found') {
        setError(
          'Connected to Facebook, but no Pages were found. Make sure your Facebook account admins at least one Page, then reconnect.'
        );
      } else {
        setFlash(`Connected ${pages} Facebook Page${pages === '1' ? '' : 's'} and ${ig} Instagram account${ig === '1' ? '' : 's'}.`);
      }
      setSearchParams({}, { replace: true });
    } else if (metaError) {
      setError(`Facebook connection failed: ${metaError}`);
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleDelete = async (id) => {
    if (!window.confirm('Disconnect this account?')) return;
    try {
      await connectionsService.remove(id);
      setConnections(prev => prev.filter(c => c.id !== id));
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to disconnect');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Connected Accounts</h1>
          <p className="text-sm text-gray-500 mt-1">
            Connect your website, Google Account, and (soon) social platforms. One Google Account grants
            Post-to access to Business Profile, Drive, Analytics, Ads and Search Console.
          </p>
        </div>
        <button
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
        >
          <Plus className="h-4 w-4" />
          Connect account
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {flash && (
        <div className="mb-4 flex items-start gap-2 p-3 bg-green-50 border border-green-200 rounded-md text-sm text-green-800">
          <Check className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{flash}</span>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : connections.length === 0 ? (
        <EmptyState onConnect={() => setPickerOpen(true)} />
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {connections.map(conn => (
            <ConnectionCard key={conn.id} connection={conn} onDelete={() => handleDelete(conn.id)} />
          ))}
        </ul>
      )}

      {pickerOpen && (
        <ConnectPickerModal
          onClose={() => setPickerOpen(false)}
          onConnected={(row) => {
            setConnections(prev => {
              const idx = prev.findIndex(c => c.id === row.id);
              if (idx >= 0) {
                const next = prev.slice();
                next[idx] = row;
                return next;
              }
              return [row, ...prev];
            });
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
};

const EmptyState = ({ onConnect }) => (
  <div className="text-center py-16 px-4 border-2 border-dashed border-gray-200 rounded-lg bg-white">
    <Globe className="h-10 w-10 text-gray-400 mx-auto mb-3" />
    <h3 className="text-base font-medium text-gray-900">No accounts connected yet</h3>
    <p className="text-sm text-gray-500 mt-1 mb-4">
      Connect a website to enable AI blog generation, or a Google Account to unlock Business Profile, Drive, Analytics, Ads and Search Console.
    </p>
    <button
      onClick={onConnect}
      className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
    >
      <Plus className="h-4 w-4" />
      Connect your first account
    </button>
  </div>
);

const ConnectionCard = ({ connection, onDelete }) => {
  const { loginForBusiness, loginForFacebook } = useAuth();
  const navigate = useNavigate();
  const meta = PROVIDER_META[connection.provider] || {
    label: connection.provider,
    icon: Globe,
    color: 'text-gray-600',
    bg: 'bg-gray-50',
  };
  const Icon = meta.icon;
  const host = connection.metadata?.host;
  const url = connection.metadata?.url || connection.external_id;
  const status = connection.status;

  // Any google_* provider mirrors a Google OAuth grant on business_profiles.
  // Reconnecting re-runs the consent flow so newly-added scopes (adwords,
  // analytics.readonly) are actually granted on the refresh token.
  const isGoogleProvider = connection.provider?.startsWith('google_');
  // facebook + instagram both derive from a single Meta OAuth grant;
  // reconnecting refreshes Page Access Tokens (60d expiry) for every Page.
  const isMetaProvider = connection.provider === 'facebook' || connection.provider === 'instagram';
  const [reconnecting, setReconnecting] = React.useState(false);

  const handleReconnect = async () => {
    setReconnecting(true);
    try {
      if (isMetaProvider) await loginForFacebook();
      else await loginForBusiness();
    } catch (e) {
      // loginForBusiness/loginForFacebook redirect on success; if they throw we clear the spinner.
      setReconnecting(false);
    }
  };

  return (
    <li className="bg-white border border-gray-200 rounded-lg p-4 flex items-start gap-3">
      <div className={`flex-shrink-0 h-10 w-10 rounded-lg ${meta.bg} flex items-center justify-center`}>
        <Icon className={`h-5 w-5 ${meta.color}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium text-gray-900 truncate">{connection.display_name || meta.label}</p>
          {status === 'active' && (
            <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700">
              <Check className="h-3 w-3 mr-0.5" />
              Active
            </span>
          )}
          {status === 'error' && (
            <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-700">
              <AlertCircle className="h-3 w-3 mr-0.5" />
              Error
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-0.5">{meta.label}</p>
        {connection.provider === 'website' && url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary-600 hover:underline mt-1"
          >
            {host || url}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {connection.metadata?.description && (
          <p className="text-xs text-gray-600 mt-2 line-clamp-2">{connection.metadata.description}</p>
        )}
        {isGoogleProvider && (
          <button
            onClick={handleReconnect}
            disabled={reconnecting}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700 disabled:opacity-50"
            title="Re-run Google's consent flow to grant any newly-added scopes (e.g. adwords, analytics.readonly)"
          >
            <RefreshCw className={`h-3 w-3 ${reconnecting ? 'animate-spin' : ''}`} />
            {reconnecting ? 'Redirecting…' : 'Reconnect Google'}
          </button>
        )}
        {isMetaProvider && (
          <button
            onClick={handleReconnect}
            disabled={reconnecting}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700 disabled:opacity-50"
            title="Re-run Meta's consent flow to refresh Page Access Tokens (they expire ~60 days after issue)"
          >
            <RefreshCw className={`h-3 w-3 ${reconnecting ? 'animate-spin' : ''}`} />
            {reconnecting ? 'Redirecting…' : 'Reconnect Facebook'}
          </button>
        )}
        {connection.provider === 'website' && (
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => navigate(`/blogs?connectionId=${connection.id}&generate=1`)}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
            >
              <Sparkles className="h-3 w-3" />
              Generate blog
            </button>
            <button
              onClick={() => navigate(`/blogs?connectionId=${connection.id}`)}
              className="text-xs font-medium text-gray-500 hover:text-gray-700"
            >
              View blogs
            </button>
          </div>
        )}
      </div>
      <button
        onClick={onDelete}
        className="flex-shrink-0 p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md"
        title="Disconnect"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
};

const ConnectPickerModal = ({ onClose, onConnected }) => {
  const [step, setStep] = useState('pick'); // 'pick' | 'website' | 'openai_ads'
  const { loginForBusiness, loginForFacebook } = useAuth();
  const navigate = useNavigate();

  const handleGoogle = async () => {
    try {
      await loginForBusiness();
    } catch (e) {
      // loginForBusiness redirects on success; if it throws, fall back to error message
      // eslint-disable-next-line no-console
      console.error('Google connect failed', e);
    }
  };

  const handleFacebook = async () => {
    // One Meta OAuth grant covers both FB Pages + linked Instagram Business
    // accounts. Backend callback enumerates /me/accounts and creates one
    // connected_accounts row per Page + per IG.
    try {
      await loginForFacebook();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Facebook connect failed', e);
    }
  };

  const handleAnalytics = () => {
    // GA4 tokens ride on the same OAuth grant as GMB (analytics.readonly is in
    // BUSINESS_SCOPES). Property selection happens inside the Analytics page.
    onClose();
    navigate('/analytics');
  };

  const handleAds = () => {
    // Google Ads tokens also ride on the same OAuth grant (adwords is in
    // BUSINESS_SCOPES). Customer selection happens inside the Ads page.
    onClose();
    navigate('/ads');
  };

  const handleSearchConsole = () => {
    // GSC tokens ride on the same OAuth grant (webmasters.readonly is in
    // BUSINESS_SCOPES). Site selection happens inside the Blogs page's
    // "Top keywords" flow — first-load there prompts to pick a site.
    onClose();
    navigate('/blogs');
  };

  const titles = {
    pick: 'Connect an account',
    website: 'Connect website',
    openai_ads: 'Connect OpenAI Ads',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">{titles[step] || titles.pick}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6">
          {step === 'pick' && (
            <PickerTiles
              onPickWebsite={() => setStep('website')}
              onPickGoogle={handleGoogle}
              onPickAnalytics={handleAnalytics}
              onPickAds={handleAds}
              onPickSearchConsole={handleSearchConsole}
              onPickOpenAiAds={() => setStep('openai_ads')}
              onPickFacebook={handleFacebook}
            />
          )}
          {step === 'website' && (
            <WebsiteForm onCancel={() => setStep('pick')} onConnected={onConnected} />
          )}
          {step === 'openai_ads' && (
            <OpenAiAdsForm onCancel={() => setStep('pick')} onConnected={onConnected} />
          )}
        </div>
      </div>
    </div>
  );
};

const PickerTiles = ({ onPickWebsite, onPickGoogle, onPickAnalytics, onPickAds, onPickSearchConsole, onPickOpenAiAds, onPickFacebook }) => {
  const tiles = [
    { key: 'website', label: 'Website', desc: 'Connect by URL for AI blogs', icon: Globe, color: 'text-emerald-600', bg: 'bg-emerald-50', onClick: onPickWebsite, enabled: true },
    { key: 'google', label: 'Google Account', desc: 'Business Profile, Drive, Analytics, Ads, Search Console — one grant', icon: Building2, color: 'text-blue-600', bg: 'bg-blue-50', onClick: onPickGoogle, enabled: true },
    { key: 'analytics', label: 'Google Analytics', desc: 'GA4 sessions, conversions, campaigns', icon: LineChart, color: 'text-orange-600', bg: 'bg-orange-50', onClick: onPickAnalytics, enabled: true },
    { key: 'ads', label: 'Google Ads', desc: 'Read-only campaign diagnostics', icon: Megaphone, color: 'text-purple-600', bg: 'bg-purple-50', onClick: onPickAds, enabled: true },
    { key: 'search_console', label: 'Google Search Console', desc: 'Top keywords → blog topics', icon: Search, color: 'text-yellow-700', bg: 'bg-yellow-50', onClick: onPickSearchConsole, enabled: true },
    { key: 'openai_ads', label: 'OpenAI Ads', desc: 'API key from ads.openai.com', icon: Bot, color: 'text-gray-900', bg: 'bg-gray-100', onClick: onPickOpenAiAds, enabled: true },
    // One Meta OAuth grant links every FB Page + IG Business account, so both
    // tiles route through the same flow. IG requires the IG account to be a
    // Business or Creator account linked to a FB Page.
    { key: 'facebook', label: 'Facebook', desc: 'Pages you admin — post + read engagement', icon: Facebook, color: 'text-indigo-600', bg: 'bg-indigo-50', onClick: onPickFacebook, enabled: true },
    { key: 'instagram', label: 'Instagram', desc: 'IG Business accounts linked to your Pages', icon: Instagram, color: 'text-pink-600', bg: 'bg-pink-50', onClick: onPickFacebook, enabled: true },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {tiles.map(t => {
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            onClick={t.enabled ? t.onClick : undefined}
            disabled={!t.enabled}
            className={`text-left p-4 border rounded-lg transition ${
              t.enabled
                ? 'border-gray-200 hover:border-primary-300 hover:bg-primary-50 cursor-pointer'
                : 'border-gray-100 bg-gray-50 cursor-not-allowed opacity-60'
            }`}
          >
            <div className={`h-9 w-9 rounded-lg ${t.bg} flex items-center justify-center mb-2`}>
              <Icon className={`h-5 w-5 ${t.color}`} />
            </div>
            <p className="font-medium text-gray-900 text-sm">{t.label}</p>
            <p className="text-xs text-gray-500 mt-0.5">{t.desc}</p>
          </button>
        );
      })}
    </div>
  );
};

const WebsiteForm = ({ onCancel, onConnected }) => {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setErr('');
    try {
      const row = await connectionsService.connectWebsite(url.trim());
      onConnected(row);
    } catch (e2) {
      setErr(e2.response?.data?.error || e2.message || 'Failed to connect website');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <label className="block text-sm font-medium text-gray-700 mb-1">Website URL</label>
      <input
        type="text"
        value={url}
        onChange={e => setUrl(e.target.value)}
        placeholder="https://yourbusiness.com"
        autoFocus
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
      />
      <p className="text-xs text-gray-500 mt-1">
        We'll fetch the page to pull your business name and description.
      </p>
      {err && (
        <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>
      )}
      <div className="flex justify-end gap-2 mt-5">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={submitting || !url.trim()}
          className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  );
};

const OpenAiAdsForm = ({ onCancel, onConnected }) => {
  const [apiKey, setApiKey] = useState('');
  const [adAccountId, setAdAccountId] = useState('');
  const [accountName, setAccountName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!apiKey.trim() || !adAccountId.trim()) return;
    setSubmitting(true);
    setErr('');
    try {
      const row = await connectionsService.connectOpenAiAds({
        apiKey: apiKey.trim(),
        adAccountId: adAccountId.trim(),
        accountName: accountName.trim() || undefined,
      });
      onConnected(row);
    } catch (e2) {
      setErr(e2.response?.data?.error || e2.message || 'Failed to connect OpenAI Ads');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="mb-3 rounded-md bg-gray-50 border border-gray-200 p-3 text-xs text-gray-600">
        <p className="font-medium text-gray-800 mb-1">Where to find these</p>
        <ol className="list-decimal ml-4 space-y-0.5">
          <li>Open <a href="https://ads.openai.com/settings" target="_blank" rel="noreferrer" className="text-primary-600 hover:underline">ads.openai.com → Settings</a></li>
          <li>Under <strong>API Keys</strong>, click <em>Create New Key</em> and copy the value</li>
          <li>Ad account ID is the <code>adacct_…</code> value in the URL (or paste the full URL — we'll extract it)</li>
        </ol>
      </div>

      <label className="block text-sm font-medium text-gray-700 mb-1">Ad account ID</label>
      <input
        type="text"
        value={adAccountId}
        onChange={e => setAdAccountId(e.target.value)}
        placeholder="adacct_6a3c21ff2230819095920c43858e0e3c"
        autoFocus
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
      />

      <label className="block text-sm font-medium text-gray-700 mb-1 mt-4">API key</label>
      <input
        type="password"
        value={apiKey}
        onChange={e => setApiKey(e.target.value)}
        placeholder="sk-…"
        autoComplete="off"
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
      />
      <p className="text-xs text-gray-500 mt-1">Stored server-side, never returned to the browser again.</p>

      <label className="block text-sm font-medium text-gray-700 mb-1 mt-4">
        Account name <span className="font-normal text-gray-400">(optional)</span>
      </label>
      <input
        type="text"
        value={accountName}
        onChange={e => setAccountName(e.target.value)}
        placeholder="Spotless Homes Florida LLC"
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
      />

      {err && (
        <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>
      )}
      <div className="flex justify-end gap-2 mt-5">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={submitting || !apiKey.trim() || !adAccountId.trim()}
          className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  );
};

export default Connections;
