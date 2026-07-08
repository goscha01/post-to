import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Globe, Building2, Instagram, Facebook, LineChart, Megaphone, Plus, Trash2, ExternalLink, X, Check, AlertCircle, RefreshCw } from 'lucide-react';
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
    label: 'Google Business Profile',
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
};

const Connections = () => {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

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
            Connect your website, Google Business Profile, and (soon) social platforms.
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
      Connect a website to enable AI blog generation, or a Google Business Profile for reviews and posts.
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
  const { loginForBusiness } = useAuth();
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
  const [reconnecting, setReconnecting] = React.useState(false);

  const handleReconnect = async () => {
    setReconnecting(true);
    try {
      await loginForBusiness();
    } catch (e) {
      // loginForBusiness redirects on success; if it throws we clear the spinner.
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
  const [step, setStep] = useState('pick'); // 'pick' | 'website'
  const { loginForBusiness } = useAuth();
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            {step === 'pick' ? 'Connect an account' : 'Connect website'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6">
          {step === 'pick' ? (
            <PickerTiles
              onPickWebsite={() => setStep('website')}
              onPickGoogle={handleGoogle}
              onPickAnalytics={handleAnalytics}
              onPickAds={handleAds}
            />
          ) : (
            <WebsiteForm onCancel={() => setStep('pick')} onConnected={onConnected} />
          )}
        </div>
      </div>
    </div>
  );
};

const PickerTiles = ({ onPickWebsite, onPickGoogle, onPickAnalytics, onPickAds }) => {
  const tiles = [
    { key: 'website', label: 'Website', desc: 'Connect by URL for AI blogs', icon: Globe, color: 'text-emerald-600', bg: 'bg-emerald-50', onClick: onPickWebsite, enabled: true },
    { key: 'google', label: 'Google Business Profile', desc: 'Reviews, posts, insights', icon: Building2, color: 'text-blue-600', bg: 'bg-blue-50', onClick: onPickGoogle, enabled: true },
    { key: 'analytics', label: 'Google Analytics', desc: 'GA4 sessions, conversions, campaigns', icon: LineChart, color: 'text-orange-600', bg: 'bg-orange-50', onClick: onPickAnalytics, enabled: true },
    { key: 'ads', label: 'Google Ads', desc: 'Read-only campaign diagnostics', icon: Megaphone, color: 'text-purple-600', bg: 'bg-purple-50', onClick: onPickAds, enabled: true },
    { key: 'instagram', label: 'Instagram', desc: 'Coming soon', icon: Instagram, color: 'text-pink-600', bg: 'bg-pink-50', enabled: false },
    { key: 'facebook', label: 'Facebook', desc: 'Coming soon', icon: Facebook, color: 'text-indigo-600', bg: 'bg-indigo-50', enabled: false },
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

export default Connections;
