// Shared composer primitives used by both the Calendar's PostComposerModal
// and the Posts page's inline form. Extracted so a change in one place —
// CTA options, Drive picker behavior, preview rendering — propagates
// consistently to both surfaces.

import React, { useEffect, useState } from 'react';
import axios from '../utils/axiosConfig';
import driveService from '../services/driveService';
import { getLastDriveFolder, rememberDriveFolder } from '../utils/composerMemory';
import {
  X,
  Plus,
  Search,
  HardDrive,
  Folder,
  ChevronRight as ChevronRightIcon,
  Home as HomeIcon,
  Image as ImageIcon,
  CheckCircle2,
  AlertCircle,
  Users,
} from 'lucide-react';

// ── CTA + post-type constants ──────────────────────────────
// Labels match Google Business Profile's Add-post UI exactly. Values are
// the GMB API actionType enums. Buy maps to SHOP under the hood; Call now
// takes a phone number rather than a URL (see CALL handling in callers).
export const CTA_OPTIONS = [
  { v: '', label: 'None' },
  { v: 'BOOK', label: 'Book' },
  { v: 'ORDER', label: 'Order online' },
  { v: 'SHOP', label: 'Buy' },
  { v: 'LEARN_MORE', label: 'Learn more' },
  { v: 'SIGN_UP', label: 'Sign up' },
  { v: 'CALL', label: 'Call now' },
];

export const POST_TYPES = [
  { v: 'UPDATE', label: 'Update' },
  { v: 'OFFER', label: 'Offer' },
  { v: 'EVENT', label: 'Event' },
];

export const isCallCta = (type) => type === 'CALL';

// ── Phone helpers ──────────────────────────────────────────
export const digitsOnly = (s) => (s || '').toString().replace(/[^\d+]/g, '');

export const looksLikePhone = (s) => {
  const d = digitsOnly(s).replace(/^\+/, '');
  return d.length >= 7 && d.length <= 15;
};

// Convert whatever the user typed into an E.164 tel: URL. Rules:
//   - If they included a leading '+', trust their country code.
//   - 10 digits, no '+': assume US, prepend +1.
//   - 11 digits starting with '1', no '+': treat as US with country code
//     already present, prepend '+'.
//   - Everything else: prepend '+' with whatever digits they provided
//     (best effort — they might be international with no + prefix).
export const toTelUrl = (raw) => {
  const d = digitsOnly(raw);
  if (d.startsWith('+')) return `tel:${d}`;
  if (d.length === 10) return `tel:+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `tel:+${d}`;
  return `tel:+${d}`;
};

// ── Drive URL helpers ──────────────────────────────────────
export const extractDriveFileId = (url) => {
  if (!url || typeof url !== 'string') return null;
  let m = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  m = url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  return null;
};

// drive.google.com/uc?export=view&id=<id> is the canonical "download URL"
// that other services (including GMB) can fetch — but only when the file's
// Drive sharing is "Anyone with the link". Otherwise this returns HTML.
export const fileToPublicUrl = (file) =>
  `https://drive.google.com/uc?export=view&id=${file.id}`;

// ── SmartPreviewImage ──────────────────────────────────────
// Renders any image URL, but for Google Drive URLs it swaps to the auth'd
// backend proxy so files that haven't been shared publicly still preview
// correctly. <img> can't send Bearer headers, so we fetch through axios
// and hand the browser a blob URL.
export const SmartPreviewImage = ({ url, className, alt = 'Preview' }) => {
  const [src, setSrc] = useState(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let blobUrl = null;
    setErrored(false);
    setSrc(null);
    if (!url) return () => {};

    const fileId = extractDriveFileId(url);
    if (!fileId) {
      setSrc(url);
      return () => {};
    }

    (async () => {
      try {
        const resp = await axios.get(`/api/drive/proxy/${fileId}`, { responseType: 'blob' });
        if (cancelled) return;
        blobUrl = URL.createObjectURL(resp.data);
        setSrc(blobUrl);
      } catch (e) {
        if (!cancelled) setErrored(true);
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url]);

  if (errored) {
    return (
      <div className={`${className} bg-gray-100 flex items-center justify-center text-xs text-gray-500 text-center p-3`}>
        Couldn't load preview.
        <br />
        Make sure Drive access is granted.
      </div>
    );
  }
  if (!src) {
    return <div className={`${className} bg-gray-100 animate-pulse`} />;
  }
  return <img src={src} alt={alt} className={className} onError={() => setErrored(true)} />;
};

// ── DrivePickerModal ───────────────────────────────────────
// Grid overlay for browsing image files across every connected business
// profile's Google Drive. See composerShared.js history for the design
// rationale — folder breadcrumb, auth'd thumbnails, per-account scope,
// duplicate detection, etc.
export const DrivePickerModal = ({ existingUrls, initialGoogleId, initialEmail, onClose, onPick }) => {
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [selectedFiles, setSelectedFiles] = useState(new Map());
  const [folderPath, setFolderPath] = useState([]);
  const initialScope = initialGoogleId ? `google:${initialGoogleId}` : initialEmail ? `email:${initialEmail}` : '';
  const [accountScope, setAccountScope] = useState(initialScope);
  const [availableAccounts, setAvailableAccounts] = useState([]);
  const [showDupConfirm, setShowDupConfirm] = useState(false);

  const currentFolderId = folderPath.length > 0 ? folderPath[folderPath.length - 1].id : '';
  const isSearching = !!debouncedQ;

  // Restore last-viewed folder for the current account scope on mount
  // (and when the user changes scope). Only restores if we haven't been
  // navigating during this session — folderPath.length === 0 guard.
  useEffect(() => {
    const last = getLastDriveFolder(accountScope);
    if (Array.isArray(last) && last.length > 0 && folderPath.length === 0) {
      setFolderPath(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountScope]);

  // Persist folder path on every change so next open restores it.
  useEffect(() => {
    rememberDriveFolder(accountScope, folderPath);
  }, [accountScope, folderPath]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setNeedsReauth(false);
      try {
        const googleId = accountScope.startsWith('google:') ? accountScope.slice(7) : '';
        const profileEmail = accountScope.startsWith('email:') ? accountScope.slice(6) : '';
        const data = await driveService.listImages({
          q: debouncedQ,
          pageSize: 100,
          folderId: isSearching ? '' : currentFolderId,
          type: isSearching ? 'images' : 'both',
          googleId,
          profileEmail,
        });
        if (cancelled) return;
        setItems(Array.isArray(data.items) ? data.items : []);
        if (Array.isArray(data.availableAccounts)) setAvailableAccounts(data.availableAccounts);
      } catch (err) {
        if (cancelled) return;
        const status = err?.response?.status;
        const code = err?.response?.data?.code;
        if (status === 403 && (code === 'DRIVE_NEEDS_REAUTH' || err?.response?.data?.needsReauth)) {
          setNeedsReauth(true);
          setError("Google Drive access hasn't been granted. Reconnect your business profile to enable it.");
        } else {
          setError(err?.response?.data?.error || err?.message || 'Failed to load Drive images');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, currentFolderId, isSearching, accountScope]);

  const toggle = (file) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.add(file.id);
      return next;
    });
    setSelectedFiles((prev) => {
      const next = new Map(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.set(file.id, file);
      return next;
    });
  };

  const enterFolder = (folder) => {
    setFolderPath((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setQuery('');
  };
  const changeAccountScope = (nextScope) => {
    setAccountScope(nextScope);
    setFolderPath([]);
    setQuery('');
  };
  const gotoRoot = () => {
    setFolderPath([]);
    setQuery('');
  };
  const gotoCrumb = (idx) => {
    setFolderPath((prev) => prev.slice(0, idx + 1));
    setQuery('');
  };

  const duplicatesInSelection = Array.from(selectedFiles.values()).filter((f) => {
    if (f.used) return true;
    const url = fileToPublicUrl(f);
    return existingUrls?.includes(url);
  });

  const finalizeAdd = (skipDups) => {
    const dupIds = new Set(duplicatesInSelection.map((f) => f.id));
    const chosen = Array.from(selectedFiles.values()).filter((f) =>
      skipDups ? !dupIds.has(f.id) : true
    );
    const urls = chosen.map(fileToPublicUrl);
    onPick(urls);
  };

  const confirm = () => {
    if (duplicatesInSelection.length > 0) {
      setShowDupConfirm(true);
      return;
    }
    finalizeAdd(false);
  };

  const folders = items.filter((f) => f.isFolder);
  const files = items.filter((f) => !f.isFolder);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-primary-600" />
              Google Drive images
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Images across every connected business profile's Drive. Files already used in a post
              show an "Already used" badge.
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

        <div className="px-5 py-3 border-b border-gray-200 space-y-2">
          {availableAccounts.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-gray-500 whitespace-nowrap">Drive:</span>
              {/* All-accounts icon: union view. Highlighted when accountScope is empty. */}
              <button
                type="button"
                onClick={() => changeAccountScope('')}
                title="All connected accounts (union)"
                className={`inline-flex items-center justify-center h-8 w-8 rounded-full border-2 transition-colors ${
                  accountScope === ''
                    ? 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                }`}
              >
                <Users className="h-4 w-4" />
              </button>
              {availableAccounts.map((a) => {
                const label = a.email || a.googleId || 'Unnamed account';
                const val = a.googleId ? `google:${a.googleId}` : `email:${a.email}`;
                const isActive = accountScope === val;
                // Derive a stable 1-char initial per email/googleId.
                const initial = (label[0] || '?').toUpperCase();
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => changeAccountScope(val)}
                    title={label}
                    className={`inline-flex items-center justify-center h-8 w-8 rounded-full border-2 text-xs font-semibold transition-colors ${
                      isActive
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {initial}
                  </button>
                );
              })}
              <span className="text-xs text-gray-500 truncate max-w-[10rem]" title={accountScope}>
                {accountScope === ''
                  ? 'All accounts'
                  : (availableAccounts.find((a) => (a.googleId ? `google:${a.googleId}` : `email:${a.email}`) === accountScope)?.email || accountScope.replace(/^(google|email):/, ''))}
              </span>
            </div>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Drive images by name…"
              className="block w-full pl-9 pr-3 py-2 border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
            />
          </div>
          {!isSearching && (
            <nav className="flex items-center gap-1 text-xs text-gray-600 flex-wrap">
              <button
                type="button"
                onClick={gotoRoot}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 ${
                  folderPath.length === 0 ? 'text-primary-700 font-medium' : ''
                }`}
              >
                <HomeIcon className="h-3.5 w-3.5" />
                My Drive
              </button>
              {folderPath.map((crumb, i) => (
                <React.Fragment key={crumb.id}>
                  <ChevronRightIcon className="h-3 w-3 text-gray-300" />
                  <button
                    type="button"
                    onClick={() => gotoCrumb(i)}
                    className={`px-2 py-1 rounded hover:bg-gray-100 truncate max-w-[12rem] ${
                      i === folderPath.length - 1 ? 'text-primary-700 font-medium' : ''
                    }`}
                    title={crumb.name}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </nav>
          )}
          {selectedFiles.size > 0 && (
            <div className="text-xs text-gray-500">
              {selectedFiles.size} selected across folders — will be added when you click "Add"
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="p-10 flex items-center justify-center">
              <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-primary-600" />
            </div>
          ) : error ? (
            <div className="p-4 rounded-md bg-red-50 border border-red-200 text-sm text-red-800">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-none" />
                <div className="flex-1">
                  <div>{error}</div>
                  {needsReauth && (
                    <a
                      href="/connections"
                      className="inline-block mt-2 text-primary-700 underline"
                    >
                      Go to Connections
                    </a>
                  )}
                </div>
              </div>
            </div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center text-sm text-gray-500">
              {debouncedQ
                ? 'No matches.'
                : folderPath.length > 0
                ? 'This folder is empty.'
                : 'No images or folders found in your Drive root.'}
            </div>
          ) : (
            <div className="space-y-4">
              {folders.length > 0 && !isSearching && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
                    Folders
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                    {folders.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => enterFolder(f)}
                        className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-left select-none"
                      >
                        <Folder className="h-5 w-5 text-primary-600 flex-none" />
                        <span className="text-sm text-gray-900 truncate" title={f.name}>
                          {f.name}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {files.length > 0 && (
                <div>
                  {folders.length > 0 && !isSearching && (
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
                      Files
                    </div>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {files.map((f) => {
                      const isSelected = selected.has(f.id);
                      const alreadyInComposer = existingUrls?.includes(fileToPublicUrl(f));
                      return (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => toggle(f)}
                          className={`relative text-left select-none rounded-lg border-2 overflow-hidden transition-colors ${
                            isSelected
                              ? 'border-primary-500 ring-2 ring-primary-200'
                              : 'border-gray-200 hover:border-gray-300'
                          } ${f.used ? 'opacity-90' : ''}`}
                        >
                          <div className="w-full aspect-square bg-gray-100 relative">
                            <SmartPreviewImage
                              url={fileToPublicUrl(f)}
                              className="w-full h-full object-cover"
                              alt={f.name}
                            />
                            {f.used && (
                              <span
                                className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/95 text-white shadow"
                                title={
                                  f.usedSource === 'scheduled'
                                    ? `In a scheduled post${f.usedAt ? ` (${new Date(f.usedAt).toLocaleDateString()})` : ''}`
                                    : f.usedAt
                                    ? `Posted on ${new Date(f.usedAt).toLocaleDateString()}`
                                    : 'Used in a previous post'
                                }
                              >
                                {f.usedSource === 'scheduled' ? 'Scheduled' : 'Already used'}
                              </span>
                            )}
                            {isSelected && (
                              <span className="absolute top-1.5 right-1.5 rounded-full bg-primary-600 text-white p-0.5 shadow">
                                <CheckCircle2 className="h-4 w-4" />
                              </span>
                            )}
                            {alreadyInComposer && !isSelected && (
                              <span
                                className="absolute bottom-1.5 right-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-800/80 text-white"
                                title="Already in the current post draft"
                              >
                                In draft
                              </span>
                            )}
                          </div>
                          <div className="p-2">
                            <div className="text-xs text-gray-900 truncate" title={f.name}>
                              {f.name}
                            </div>
                            {f.modifiedTime && (
                              <div className="text-[10px] text-gray-500 mt-0.5">
                                {new Date(f.modifiedTime).toLocaleDateString()}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between gap-2">
          <div className="text-xs text-gray-500">
            {selected.size > 0
              ? `${selected.size} selected · make sure the files are set to "Anyone with link" on Drive so GMB can fetch them.`
              : 'Click images to select · files must be shared publicly on Drive for GMB to fetch them.'}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={selected.size === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
              Add {selected.size > 0 ? `${selected.size} ` : ''}image{selected.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>

        {showDupConfirm && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setShowDupConfirm(false)}
          >
            <div
              className="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-2">
                <AlertCircle className="h-5 w-5 text-amber-500 mt-0.5 flex-none" />
                <div>
                  <h4 className="text-sm font-semibold text-gray-900">
                    {duplicatesInSelection.length} of {selectedFiles.size} already{' '}
                    {duplicatesInSelection.every((f) => f.usedSource === 'scheduled')
                      ? 'scheduled'
                      : duplicatesInSelection.every((f) => f.usedSource === 'published')
                      ? 'published'
                      : 'used'}
                  </h4>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Adding these again will send the same image twice.
                  </p>
                </div>
              </div>
              <ul className="px-5 py-3 space-y-1 max-h-56 overflow-y-auto">
                {duplicatesInSelection.map((f) => {
                  const inDraft = existingUrls?.includes(fileToPublicUrl(f));
                  const label = inDraft
                    ? 'in the current draft'
                    : f.usedSource === 'scheduled'
                    ? `in a scheduled post${f.usedAt ? ` (${new Date(f.usedAt).toLocaleDateString()})` : ''}`
                    : `posted${f.usedAt ? ` on ${new Date(f.usedAt).toLocaleDateString()}` : ''}`;
                  return (
                    <li key={f.id} className="text-xs text-gray-700 flex items-start gap-2">
                      <span className="text-amber-500">•</span>
                      <span className="flex-1 min-w-0">
                        <span className="font-medium truncate block" title={f.name}>{f.name}</span>
                        <span className="text-gray-500">{label}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2 bg-gray-50">
                <button
                  type="button"
                  onClick={() => setShowDupConfirm(false)}
                  className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => finalizeAdd(true)}
                  className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Skip duplicates
                </button>
                <button
                  type="button"
                  onClick={() => finalizeAdd(false)}
                  className="px-3 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700"
                >
                  Keep all
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
