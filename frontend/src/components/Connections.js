import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Globe, Building2, Instagram, Facebook, LineChart, Megaphone, Bot, Search, Plus, Trash2, ExternalLink, X, Check, AlertCircle, RefreshCw, Sparkles, Download, Copy, ChevronRight, ChevronDown, ShoppingBag, Heart, Rss, Link2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import connectionsService from '../services/connectionsService';
import BlogIntegrationForm, {
  PROVIDER_CONFIGS as BLOG_CONFIGS,
  SquarespaceGlyph,
  BigCommerceGlyph,
  DudaGlyph,
  HubSpotGlyph,
  GoHighLevelGlyph,
} from './BlogIntegrationForm';
import { LovableForm, RssFeedForm, HostedBlogForm, WebhookForm } from './AdvancedIntegrations';

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
  wordpress: {
    label: 'WordPress',
    icon: WordPressGlyph,
    color: 'text-emerald-700',
    bg: 'bg-emerald-50',
  },
  shopify: {
    label: 'Shopify',
    icon: ShoppingBag,
    color: 'text-emerald-700',
    bg: 'bg-emerald-50',
  },
  webflow: {
    label: 'Webflow',
    icon: WebflowGlyph,
    color: 'text-indigo-600',
    bg: 'bg-indigo-50',
  },
  wix: {
    label: 'Wix',
    icon: WixGlyph,
    color: 'text-amber-700',
    bg: 'bg-amber-50',
  },
  squarespace: {
    label: 'Squarespace',
    icon: SquarespaceGlyph,
    color: 'text-gray-900',
    bg: 'bg-gray-100',
  },
  bigcommerce: {
    label: 'BigCommerce',
    icon: BigCommerceGlyph,
    color: 'text-blue-700',
    bg: 'bg-blue-50',
  },
  duda: {
    label: 'Duda',
    icon: DudaGlyph,
    color: 'text-indigo-600',
    bg: 'bg-indigo-50',
  },
  hubspot: {
    label: 'HubSpot',
    icon: HubSpotGlyph,
    color: 'text-orange-600',
    bg: 'bg-orange-50',
  },
  gohighlevel: {
    label: 'GoHighLevel',
    icon: GoHighLevelGlyph,
    color: 'text-gray-100',
    bg: 'bg-gray-900',
  },
  lovable: {
    label: 'Lovable',
    icon: Heart,
    color: 'text-pink-600',
    bg: 'bg-pink-50',
  },
  rss: {
    label: 'RSS & JSON Feeds',
    icon: Rss,
    color: 'text-orange-600',
    bg: 'bg-orange-50',
  },
  hosted_blog: {
    label: 'Hosted Blog',
    icon: Globe,
    color: 'text-emerald-600',
    bg: 'bg-emerald-50',
  },
  webhook: {
    label: 'Webhook',
    icon: Link2,
    color: 'text-purple-600',
    bg: 'bg-purple-50',
  },
};

// Small inline "W" glyph — lucide-react doesn't ship a WordPress icon and we
// don't want to add a brand-icon dep just for one tile.
function WordPressGlyph({ className = '' }) {
  return (
    <span className={`inline-flex items-center justify-center font-bold text-[13px] leading-none ${className}`}>
      W
    </span>
  );
}

// Webflow "W" glyph — italic serif to differentiate from WordPress.
function WebflowGlyph({ className = '' }) {
  return (
    <span className={`inline-flex items-center justify-center italic font-bold text-[13px] leading-none ${className}`}>
      W
    </span>
  );
}

// Wix wordmark — short enough to render inline.
function WixGlyph({ className = '' }) {
  return (
    <span className={`inline-flex items-center justify-center font-bold text-[10px] tracking-tight leading-none ${className}`}>
      WIX
    </span>
  );
}

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

// Steps that use the shared BlogIntegrationForm — the config maps 1:1 to
// PROVIDER_CONFIGS in BlogIntegrationForm.js.
const BLOG_STEPS = ['shopify', 'webflow', 'wix', 'squarespace', 'bigcommerce', 'duda', 'hubspot', 'gohighlevel'];

// Steps that use a bespoke form component from AdvancedIntegrations.js.
const ADVANCED_STEPS = {
  lovable: LovableForm,
  rss: RssFeedForm,
  hosted_blog: HostedBlogForm,
  webhook: WebhookForm,
};

// Brand-icon injection — several BlogIntegrationForm configs are declared
// with `brandIcon: null` because the glyph components live here in Connections.js
// (they share their SVGs with the connection cards). Wire them up at runtime.
const BLOG_BRAND_ICONS = {
  webflow: WebflowGlyph,
  wix: WixGlyph,
  squarespace: SquarespaceGlyph,
  bigcommerce: BigCommerceGlyph,
  duda: DudaGlyph,
  hubspot: HubSpotGlyph,
  gohighlevel: GoHighLevelGlyph,
};

const ConnectPickerModal = ({ onClose, onConnected }) => {
  const [step, setStep] = useState('pick');
  const { loginForBusiness, loginForFacebook } = useAuth();
  const navigate = useNavigate();

  // Lock <body> scroll while the modal is open so the background page can't
  // scroll behind it. Restores the prior overflow value on unmount so we
  // don't clobber a page that had a custom overflow set.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

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
    wordpress: 'Connect WordPress',
    shopify: 'Connect Shopify',
    webflow: 'Connect Webflow',
    wix: 'Connect Wix',
    squarespace: 'Connect Squarespace',
    bigcommerce: 'Connect BigCommerce',
    duda: 'Connect Duda',
    hubspot: 'Connect HubSpot',
    gohighlevel: 'Connect GoHighLevel',
    lovable: 'Connect Lovable',
    rss: 'RSS & JSON Feeds',
    hosted_blog: 'Hosted Blog',
    webhook: 'Connect Webhook',
  };

  // Compact modal for the simple flows (website + OpenAI Ads); wider modal
  // for the publishing-platform wizards that show step guides, code blocks
  // and payload tables. Height is capped by the modal itself (see below).
  const widthClass = step === 'pick' || step === 'website' || step === 'openai_ads' ? 'max-w-lg' : 'max-w-3xl';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      {/* Modal is a flex column with a hard height cap so long wizards
          (WordPress, BigCommerce, Webhook payload spec, etc.) scroll inside
          instead of pushing the modal past the viewport. */}
      <div
        className={`bg-white rounded-lg shadow-xl w-full ${widthClass} flex flex-col max-h-[90vh]`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">{titles[step] || titles.pick}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 flex-1 overflow-y-auto">
          {step === 'pick' && (
            <PickerTiles
              onPickWebsite={() => setStep('website')}
              onPickGoogle={handleGoogle}
              onPickAnalytics={handleAnalytics}
              onPickAds={handleAds}
              onPickSearchConsole={handleSearchConsole}
              onPickOpenAiAds={() => setStep('openai_ads')}
              onPickFacebook={handleFacebook}
              onPickWordpress={() => setStep('wordpress')}
              onPickBlogProvider={(key) => setStep(key)}
              onPickAdvanced={(key) => setStep(key)}
            />
          )}
          {step === 'website' && (
            <WebsiteForm onCancel={() => setStep('pick')} onConnected={onConnected} />
          )}
          {step === 'openai_ads' && (
            <OpenAiAdsForm onCancel={() => setStep('pick')} onConnected={onConnected} />
          )}
          {step === 'wordpress' && (
            <WordPressWizard onCancel={() => setStep('pick')} onConnected={onConnected} />
          )}
          {BLOG_STEPS.includes(step) && (
            <BlogIntegrationForm
              config={{
                ...BLOG_CONFIGS[step],
                brandIcon: BLOG_CONFIGS[step].brandIcon || BLOG_BRAND_ICONS[step],
              }}
              onCancel={() => setStep('pick')}
              onConnected={onConnected}
            />
          )}
          {ADVANCED_STEPS[step] && React.createElement(ADVANCED_STEPS[step], {
            onCancel: () => setStep('pick'),
            onConnected,
          })}
        </div>
      </div>
    </div>
  );
};

const PickerTiles = ({ onPickWebsite, onPickGoogle, onPickAnalytics, onPickAds, onPickSearchConsole, onPickOpenAiAds, onPickFacebook, onPickWordpress, onPickBlogProvider, onPickAdvanced }) => {
  // Grouped so the picker doesn't turn into a 20-tile wall. Publishing
  // Platforms — everything that writes an article to a CMS — is now its own
  // section, matching the reference product layout.
  const groups = [
    {
      title: 'Accounts',
      tiles: [
        { key: 'website', label: 'Website', desc: 'Connect by URL for AI blogs', icon: Globe, color: 'text-emerald-600', bg: 'bg-emerald-50', onClick: onPickWebsite },
        { key: 'google', label: 'Google Account', desc: 'Business Profile, Drive, Analytics, Ads, Search Console — one grant', icon: Building2, color: 'text-blue-600', bg: 'bg-blue-50', onClick: onPickGoogle },
        { key: 'analytics', label: 'Google Analytics', desc: 'GA4 sessions, conversions, campaigns', icon: LineChart, color: 'text-orange-600', bg: 'bg-orange-50', onClick: onPickAnalytics },
        { key: 'ads', label: 'Google Ads', desc: 'Read-only campaign diagnostics', icon: Megaphone, color: 'text-purple-600', bg: 'bg-purple-50', onClick: onPickAds },
        { key: 'search_console', label: 'Google Search Console', desc: 'Top keywords → blog topics', icon: Search, color: 'text-yellow-700', bg: 'bg-yellow-50', onClick: onPickSearchConsole },
        { key: 'openai_ads', label: 'OpenAI Ads', desc: 'API key from ads.openai.com', icon: Bot, color: 'text-gray-900', bg: 'bg-gray-100', onClick: onPickOpenAiAds },
        // One Meta OAuth grant links every FB Page + IG Business account, so both
        // tiles route through the same flow.
        { key: 'facebook', label: 'Facebook', desc: 'Pages you admin — post + read engagement', icon: Facebook, color: 'text-indigo-600', bg: 'bg-indigo-50', onClick: onPickFacebook },
        { key: 'instagram', label: 'Instagram', desc: 'IG Business accounts linked to your Pages', icon: Instagram, color: 'text-pink-600', bg: 'bg-pink-50', onClick: onPickFacebook },
      ],
    },
    {
      title: 'Publishing Platform',
      tiles: [
        { key: 'wordpress', label: 'WordPress', desc: 'Plugin integration', icon: WordPressGlyph, color: 'text-emerald-700', bg: 'bg-emerald-50', onClick: onPickWordpress },
        { key: 'shopify', label: 'Shopify', desc: 'Store blog integration', icon: ShoppingBag, color: 'text-emerald-700', bg: 'bg-emerald-50', onClick: () => onPickBlogProvider('shopify') },
        { key: 'webflow', label: 'Webflow', desc: 'API integration', icon: WebflowGlyph, color: 'text-indigo-600', bg: 'bg-indigo-50', onClick: () => onPickBlogProvider('webflow') },
        { key: 'wix', label: 'Wix', desc: 'Blog integration', icon: WixGlyph, color: 'text-amber-700', bg: 'bg-amber-50', onClick: () => onPickBlogProvider('wix') },
        { key: 'squarespace', label: 'Squarespace', desc: 'Publish to blog', icon: SquarespaceGlyph, color: 'text-gray-900', bg: 'bg-gray-100', onClick: () => onPickBlogProvider('squarespace') },
        { key: 'bigcommerce', label: 'BigCommerce', desc: 'Blog integration', icon: BigCommerceGlyph, color: 'text-blue-700', bg: 'bg-blue-50', onClick: () => onPickBlogProvider('bigcommerce') },
        { key: 'duda', label: 'Duda', desc: 'Publish to blog', icon: DudaGlyph, color: 'text-indigo-600', bg: 'bg-indigo-50', onClick: () => onPickBlogProvider('duda') },
        { key: 'hubspot', label: 'HubSpot', desc: 'Publish to blog', icon: HubSpotGlyph, color: 'text-orange-600', bg: 'bg-orange-50', onClick: () => onPickBlogProvider('hubspot') },
        { key: 'gohighlevel', label: 'GoHighLevel', desc: 'Publish to blog', icon: GoHighLevelGlyph, color: 'text-gray-100', bg: 'bg-gray-900', onClick: () => onPickBlogProvider('gohighlevel') },
        { key: 'lovable', label: 'Lovable', desc: 'AI-built blog', icon: Heart, color: 'text-pink-600', bg: 'bg-pink-50', onClick: () => onPickAdvanced('lovable') },
        { key: 'rss', label: 'RSS/Feeds', desc: 'Static sites & readers', icon: Rss, color: 'text-orange-600', bg: 'bg-orange-50', onClick: () => onPickAdvanced('rss') },
        { key: 'hosted_blog', label: 'Hosted Blog', desc: 'We host it for you', icon: Globe, color: 'text-emerald-600', bg: 'bg-emerald-50', onClick: () => onPickAdvanced('hosted_blog') },
        { key: 'webhook', label: 'Webhooks', desc: 'Any endpoint', icon: Link2, color: 'text-purple-600', bg: 'bg-purple-50', onClick: () => onPickAdvanced('webhook') },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      {groups.map(g => (
        <div key={g.title}>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{g.title}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {g.tiles.map(t => {
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  onClick={t.onClick}
                  className="text-left p-4 border border-gray-200 rounded-lg transition hover:border-primary-300 hover:bg-primary-50 cursor-pointer"
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
        </div>
      ))}
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

// ---------------------------------------------------------------------------
// WordPress connect wizard
// ---------------------------------------------------------------------------
// 3-step flow matching the reference design:
//   1. Your URL      — enter WP site URL, verify WordPress is running
//   2. Install Plugin — plugin install instructions (screenshot pending)
//   3. Connect       — final connection test (screenshot pending)
//
// Step 1 also shows a manual-install fallback (download .zip + API key) for
// hosts / IT teams that block installs from the WP plugin directory.

const WP_STEPS = [
  { key: 'url', label: 'Your URL' },
  { key: 'plugin', label: 'Install Plugin' },
  { key: 'connect', label: 'Connect' },
];

const WordPressWizard = ({ onCancel, onConnected }) => {
  const [stepIdx, setStepIdx] = useState(0);
  const [url, setUrl] = useState('');

  return (
    <div>
      <WpStepper stepIdx={stepIdx} onStepClick={setStepIdx} />

      <div className="mt-6">
        {stepIdx === 0 && (
          <WpStepUrl
            url={url}
            setUrl={setUrl}
            onVerified={() => setStepIdx(1)}
            onCancel={onCancel}
          />
        )}
        {stepIdx === 1 && (
          <WpStepPlaceholder
            title="Install Plugin"
            onBack={() => setStepIdx(0)}
            onNext={() => setStepIdx(2)}
          />
        )}
        {stepIdx === 2 && (
          <WpStepPlaceholder
            title="Connect"
            onBack={() => setStepIdx(1)}
            onNext={() => onConnected && onConnected({ id: 'wp-placeholder', provider: 'wordpress', display_name: url, status: 'active' })}
            nextLabel="Finish"
          />
        )}
      </div>
    </div>
  );
};

const WpStepper = ({ stepIdx, onStepClick }) => (
  <ol className="flex items-center justify-center gap-8 text-sm">
    {WP_STEPS.map((s, i) => {
      const active = i === stepIdx;
      const done = i < stepIdx;
      const clickable = i <= stepIdx;
      return (
        <li key={s.key} className="flex items-center gap-2">
          <button
            type="button"
            disabled={!clickable}
            onClick={() => clickable && onStepClick(i)}
            className={`font-medium ${
              active ? 'text-emerald-600' : done ? 'text-gray-700 hover:text-emerald-600' : 'text-gray-400'
            } ${clickable ? 'cursor-pointer' : 'cursor-not-allowed'}`}
          >
            {s.label}
          </button>
          {i < WP_STEPS.length - 1 && (
            <span className="text-gray-300">·</span>
          )}
        </li>
      );
    })}
  </ol>
);

const WpStepUrl = ({ url, setUrl, onVerified, onCancel }) => {
  const [verifying, setVerifying] = useState(false);
  const [err, setErr] = useState('');
  // Placeholder API key + version — real values will come from backend once
  // the /api/connections/wordpress/init endpoint lands.
  const apiKey = 'aseo_50f18a766d876481fad5a8b0aa49941f';
  const pluginVersion = 'v1.3.105';
  const pluginFile = 'post-to-wp.zip';
  const [copied, setCopied] = useState(false);
  const [howToOpen, setHowToOpen] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setVerifying(true);
    setErr('');
    // TODO: hit backend verify endpoint — for now advance to next step.
    setTimeout(() => {
      setVerifying(false);
      onVerified();
    }, 400);
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {
      // noop — clipboard not available
    }
  };

  return (
    <div className="space-y-6">
      {/* Primary "verify URL" card */}
      <div className="bg-white border border-gray-200 rounded-lg p-8">
        <div className="flex flex-col items-center text-center">
          <div className="h-12 w-12 rounded-lg bg-emerald-50 flex items-center justify-center mb-3">
            <Globe className="h-6 w-6 text-emerald-600" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900">What's your WordPress website URL?</h3>
          <p className="text-sm text-gray-500 mt-1">We'll verify that WordPress is running on your site</p>
        </div>

        <form onSubmit={submit} className="mt-6 max-w-xl mx-auto">
          <label htmlFor="wp-url" className="block text-sm font-medium text-gray-700 mb-1">WordPress URL</label>
          <div className="relative">
            <input
              id="wp-url"
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="yourdomain.com"
              autoFocus
              className="w-full pl-3 pr-10 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            />
            <Globe className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          </div>
          <p className="text-xs text-gray-500 mt-1">You can enter with or without https://</p>

          {err && (
            <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>
          )}

          <button
            type="submit"
            disabled={verifying || !url.trim()}
            className="mt-5 w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-emerald-500 text-white text-sm font-semibold rounded-md hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {verifying ? 'Verifying…' : 'Verify WordPress'}
            {!verifying && <ChevronRight className="h-4 w-4" />}
          </button>
        </form>
      </div>

      {/* Manual-install fallback card */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-md bg-gray-100 flex items-center justify-center flex-shrink-0">
            <Download className="h-4 w-4 text-gray-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-gray-900">Prefer to install the plugin manually?</h4>
            <p className="text-xs text-gray-500 mt-0.5">
              Some hosts and IT teams don't allow installs from the WordPress plugin directory.
              Download the ZIP here and upload it directly in <strong>Plugins → Add New → Upload Plugin</strong>.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-800"
              >
                <Download className="h-4 w-4" />
                Download plugin (.zip)
              </button>
              <span className="text-xs text-gray-500">
                Latest version: <span className="font-medium text-gray-700">{pluginVersion}</span>
                <span className="mx-1">·</span>
                filename: <code className="px-1.5 py-0.5 bg-gray-100 rounded text-[11px]">{pluginFile}</code>
              </span>
            </div>

            <div className="mt-4 bg-emerald-50/60 border border-emerald-200 rounded-md p-3">
              <p className="text-xs font-semibold text-emerald-800 mb-1.5">Your API Key</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={apiKey}
                  className="flex-1 px-3 py-2 bg-white border border-emerald-200 rounded-md text-xs font-mono text-gray-800 focus:outline-none"
                  onFocus={e => e.target.select()}
                />
                <button
                  type="button"
                  onClick={copyKey}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white text-xs font-medium rounded-md hover:bg-emerald-700"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-[11px] text-emerald-700 mt-1.5">Paste this into the plugin settings after activating.</p>
            </div>

            <button
              type="button"
              onClick={() => setHowToOpen(o => !o)}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900"
            >
              {howToOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              How to upload it to WordPress
            </button>
            {howToOpen && (
              <ol className="mt-2 ml-5 text-xs text-gray-600 space-y-1 list-decimal">
                <li>Log in to your WordPress admin dashboard.</li>
                <li>Go to <strong>Plugins → Add New → Upload Plugin</strong>.</li>
                <li>Choose the <code>{pluginFile}</code> file you downloaded and click <em>Install Now</em>.</li>
                <li>Click <em>Activate Plugin</em>.</li>
                <li>Open the plugin settings and paste the API key from above.</li>
              </ol>
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Back to providers
        </button>
      </div>
    </div>
  );
};

// Placeholder shells for steps 2 + 3 — replaced once the reference screenshots
// arrive. Kept minimal so the wizard is navigable end-to-end today.
const WpStepPlaceholder = ({ title, onBack, onNext, nextLabel = 'Next' }) => (
  <div>
    <div className="bg-white border border-dashed border-gray-300 rounded-lg p-10 text-center">
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      <p className="text-sm text-gray-500 mt-1">UI pending — waiting on the reference screenshot for this step.</p>
    </div>
    <div className="flex justify-between mt-6">
      <button
        type="button"
        onClick={onBack}
        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
      >
        Back
      </button>
      <button
        type="button"
        onClick={onNext}
        className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-md hover:bg-emerald-700"
      >
        {nextLabel}
      </button>
    </div>
  </div>
);

export default Connections;
