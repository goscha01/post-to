import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from '../utils/axiosConfig';
import { useAuth } from '../contexts/AuthContext';
import ImageUploader from './react_imgbb_uploader.js';
import imageService from '../services/imageService';
import businessProfileService from '../services/businessProfileService';
import postsService from '../services/postsService';
import calendarService from '../services/calendarService';
import {
  getRecentUrls,
  rememberUrl,
  getRecentPhones,
  rememberPhone,
} from '../utils/composerMemory';
import connectionsService from '../services/connectionsService';
import {
  FileText,
  Plus,
  Edit,
  Trash2,
  Calendar,
  Clock,
  CheckCircle,
  AlertCircle,
  Eye,
  BarChart3,
  Heart,
  MessageCircle,
  Share,
  RefreshCw,
  HardDrive,
  Sparkles,
  Building2,
  Facebook,
  Instagram,
  Check,
  X,
  ExternalLink,
} from 'lucide-react';
import {
  CTA_OPTIONS,
  isCallCta,
  looksLikePhone,
  toTelUrl,
  digitsOnly, // eslint-disable-line no-unused-vars
  SmartPreviewImage,
  DrivePickerModal,
} from './composerShared';

// Post Image Component
const PostImage = ({ imageUrl, altText, mediaFormat, mediaData }) => {
  const [imageSrc, setImageSrc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchImage = async () => {
      if (!imageUrl) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(false);

        // If we have cached base64 data, use it directly
        if (mediaData && mediaData.data && mediaData.fromCache) {
          setImageSrc(mediaData.data);
          setLoading(false);
          return;
        }

        // Otherwise, fetch through the image service (which uses proxy-image endpoint)
        const result = await imageService.getImage(imageUrl);
        
        if (result.success) {
          setImageSrc(result.dataUrl);
        } else {
          setError(true);
        }
      } catch (err) {
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchImage();
  }, [imageUrl, mediaData]);

  if (loading) {
    return (
      <div className="w-full h-48 bg-gray-200 rounded-t-lg flex items-center justify-center animate-pulse">
        <div className="h-8 w-8 bg-gray-400 rounded"></div>
      </div>
    );
  }

  if (error || !imageSrc) {
    return (
      <div className="w-full h-48 bg-gray-200 rounded-t-lg flex items-center justify-center text-sm text-gray-500">
        Image not available
      </div>
    );
  }

  return (
    <div className="relative">
      <img
        src={imageSrc}
        alt={altText}
        className="w-full h-48 object-cover shadow-sm"
      />
      {mediaFormat === 'VIDEO' && (
        <div className="absolute top-2 right-2 bg-black bg-opacity-75 text-white text-xs px-2 py-1 rounded">
          VIDEO
        </div>
      )}
    </div>
  );
};

// Chip avatar. Any googleusercontent.com URL (GMB profile picture) routes
// through the backend proxy — direct <img> gets 400 from Google's CDN.
// FB/IG CDN URLs load cross-origin, direct <img>. On failure or missing
// URL: shows a provider-appropriate icon (Building2 / Facebook / Instagram)
// tinted to match the platform, so the chip still communicates *what* it is.
const ChipAvatar = ({ url, label, selected, provider }) => {
  const needsProxy = typeof url === 'string' && url.includes('googleusercontent.com');
  const [resolvedUrl, setResolvedUrl] = useState(needsProxy ? null : url);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!url) { setResolvedUrl(null); return; }
    if (!needsProxy) { setResolvedUrl(url); setError(false); return; }
    setResolvedUrl(null);
    setError(false);
    imageService.getImage(url).then((result) => {
      if (cancelled) return;
      if (result?.success && result.dataUrl) setResolvedUrl(result.dataUrl);
      else setError(true);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [url, needsProxy]);

  const grayscaleClass = selected ? '' : 'opacity-70 grayscale group-hover:grayscale-0';

  if (resolvedUrl && !error) {
    return (
      <img
        src={resolvedUrl}
        alt={label}
        className={`h-full w-full object-cover ${grayscaleClass}`}
        onError={() => setError(true)}
      />
    );
  }
  // Fallback: provider-appropriate icon inside a tinted background so the
  // chip still visually communicates the platform when the CDN URL fails
  // (common for GMB when the OAuth token is expired).
  if (provider === 'facebook') {
    return (
      <div className="h-full w-full bg-indigo-50 flex items-center justify-center">
        <Facebook className="h-6 w-6 text-indigo-600" />
      </div>
    );
  }
  if (provider === 'instagram') {
    return (
      <div className="h-full w-full bg-pink-50 flex items-center justify-center">
        <Instagram className="h-6 w-6 text-pink-600" />
      </div>
    );
  }
  // GMB / unknown
  return (
    <div className="h-full w-full bg-blue-50 flex items-center justify-center">
      <Building2 className="h-6 w-6 text-blue-600" />
    </div>
  );
};

// Multi-select target picker: chips laid out horizontally, each showing a
// business avatar (or fallback icon) with a small platform badge in the
// bottom-right corner. Selected chips get a colored ring + a checkmark
// overlay. Header has a "Select All" checkbox + count. Purely presentational
// — parent owns the `selected: Set<string>` state.
const TargetChipsPicker = ({ targets, selected, onChange }) => {
  const total = targets.length;
  const selCount = selected.size;
  const allSelected = total > 0 && selCount === total;

  const toggle = (key) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };
  const toggleAll = () => {
    if (allSelected) onChange(new Set());
    else onChange(new Set(targets.map((t) => t.key)));
  };

  const providerIcon = (provider) => {
    if (provider === 'facebook') return { Icon: Facebook, wrap: 'bg-indigo-600', color: 'text-white' };
    if (provider === 'instagram') return { Icon: Instagram, wrap: 'bg-pink-600', color: 'text-white' };
    return { Icon: Building2, wrap: 'bg-blue-600', color: 'text-white' };
  };

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-gray-900">
          Click to select which accounts you want to post to
        </h3>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
          />
          Select All
        </label>
      </div>

      {total === 0 ? (
        <div className="text-sm text-gray-500 py-6 text-center border-2 border-dashed border-gray-200 rounded-md">
          No business profiles connected yet. Connect one from the Connections page.
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {targets.map((t) => {
            const isSelected = selected.has(t.key);
            const { Icon, wrap, color } = providerIcon(t.provider);
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => toggle(t.key)}
                title={`${t.label} — ${t.accountLabel}`}
                className={`relative group flex-shrink-0 rounded-full transition
                  ${isSelected
                    ? 'ring-2 ring-primary-500 ring-offset-2'
                    : 'ring-1 ring-gray-200 hover:ring-primary-300'}
                `}
              >
                {/* Avatar (ChipAvatar handles the imageService proxy for GMB URLs) */}
                <div className="h-12 w-12 rounded-full overflow-hidden bg-gray-100 flex items-center justify-center">
                  <ChipAvatar url={t.avatarUrl} label={t.label} selected={isSelected} provider={t.provider} />
                </div>
                {/* Platform badge (bottom-right corner) */}
                <span className={`absolute -bottom-0.5 -right-0.5 h-5 w-5 rounded-full ${wrap} flex items-center justify-center ring-2 ring-white`}>
                  <Icon className={`h-3 w-3 ${color}`} />
                </span>
                {/* Selected checkmark (top-right corner) */}
                {isSelected && (
                  <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary-600 flex items-center justify-center ring-2 ring-white">
                    <Check className="h-3 w-3 text-white" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-4 text-sm text-gray-500">
        {selCount} of {total} account{total === 1 ? '' : 's'} selected
      </div>
    </div>
  );
};

const Posts = () => {
  const { isAuthenticated, isDisconnected } = useAuth();
  const [searchParams] = useSearchParams();
  const [posts, setPosts] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Multi-select target set. Each key is a GMB path ('accounts/X/locations/Y')
  // or a social prefix ('fb:<id>' | 'ig:<id>'). Publish fans out to every
  // selected target with Promise.allSettled.
  const [selectedTargets, setSelectedTargets] = useState(() => new Set());
  // The single "focused" target used for viewing recent posts + editing +
  // deleting. Derived from selectedTargets — set to the first selected key
  // whenever the selection changes. Kept as separate state so downstream
  // handlers (edit/delete/refresh) can keep their existing shape.
  const [selectedProfile, setSelectedProfile] = useState('');
  // Facebook Pages + Instagram Business connections from /api/connections.
  const [socialProfiles, setSocialProfiles] = useState([]);
  // Per-publish target results — { successCount, failCount, failures: [{targetLabel, error}] }
  const [publishSummary, setPublishSummary] = useState(null);
  // Composer modal open/close. Also flips true automatically whenever
  // editingPost is set (so clicking Edit on an existing post opens the modal).
  const [showComposer, setShowComposer] = useState(false);
  
  
  // Expanded posts state
  const [expandedPosts, setExpandedPosts] = useState(new Set());
  
  // Delete loading state
  const [deletingPosts, setDeletingPosts] = useState(new Set());
   
      // Post creation loading state
   const [creatingPost, setCreatingPost] = useState(false);
   
   // Post update loading state
   const [updatingPost, setUpdatingPost] = useState(false);
   
   // Image upload loading state
   const [uploadingImages, setUploadingImages] = useState(false);
   
   // File upload state
   const [uploadedFiles, setUploadedFiles] = useState([]);

   // Drive picker + AI composer state (shared behavior with Calendar composer)
   const [drivePickerOpen, setDrivePickerOpen] = useState(false);
   const [aiGenerating, setAiGenerating] = useState(false);
   const [aiError, setAiError] = useState(null);
   const [aiJustFilled, setAiJustFilled] = useState(false);
   const [aiImageDescriptions, setAiImageDescriptions] = useState([]);

   // Timing: publish now vs. schedule for later. Datetime default = 1h out.
   const [postingMode, setPostingMode] = useState('now'); // 'now' | 'later'
   const [scheduledAt, setScheduledAt] = useState(() => {
     const d = new Date(Date.now() + 60 * 60 * 1000);
     const pad = (n) => String(n).padStart(2, '0');
     return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
   });
   
   // Edit post state
   const [editingPost, setEditingPost] = useState(null);
       const [editFormData, setEditFormData] = useState({
      summary: '',
      postType: 'UPDATE',
      callToAction: {
        type: '',
        url: ''
      },
      mediaUrls: ['']
    });
   
   // Notification state
   const [notification, setNotification] = useState(null);
  
     const [formData, setFormData] = useState({
     summary: '',
     postType: 'UPDATE',
     callToAction: {
       type: '',
       url: ''
     },
     mediaUrls: ['']
   });

   // Saved drafts (server-persisted via scheduled_posts.status='draft').
   // Distinct from the existing `_isDraft` UI flag on posts already in flight.
   const [savedDrafts, setSavedDrafts] = useState([]);
   const [savedDraftsLoading, setSavedDraftsLoading] = useState(false);
   const [activeDraftId, setActiveDraftId] = useState(null);
   const [savingDraft, setSavingDraft] = useState(false);
   const [draftSavedAt, setDraftSavedAt] = useState(null);

  // Flatten GMB locations + social connections into a single ordered array
  // of chip descriptors — one per posting target. Consumed by the chip
  // picker and the fan-out publish loop. Ordered: GMB first, then FB, then IG.
  const targets = useMemo(() => {
    const out = [];
    for (const p of profiles || []) {
      const acctAvatar = p.accountProfilePicture?.googleUrl || null;
      const acctName = p.businessName || p.accountName || 'Google Business';
      for (const loc of p.locations || []) {
        out.push({
          key: loc.fullPath,
          provider: 'gmb',
          label: loc.title || loc.locationName || 'Untitled Location',
          accountLabel: acctName,
          avatarUrl: acctAvatar,
        });
      }
    }
    for (const r of socialProfiles || []) {
      if (r.provider === 'facebook') {
        out.push({
          key: `fb:${r.id}`,
          provider: 'facebook',
          label: r.display_name,
          accountLabel: r.metadata?.category || 'Facebook Page',
          avatarUrl: r.metadata?.picture_url || null,
        });
      }
    }
    for (const r of socialProfiles || []) {
      if (r.provider === 'instagram') {
        out.push({
          key: `ig:${r.id}`,
          provider: 'instagram',
          label: r.display_name,
          accountLabel: r.metadata?.ig_username ? `@${r.metadata.ig_username}` : 'Instagram Business',
          avatarUrl: r.metadata?.picture_url || null,
        });
      }
    }
    return out;
  }, [profiles, socialProfiles]);

  // Keep selectedProfile (single view/edit target) in sync with the multi-
  // select. First selected key wins. Empty when nothing is selected.
  useEffect(() => {
    const firstSelected = targets.find(t => selectedTargets.has(t.key));
    setSelectedProfile(firstSelected ? firstSelected.key : '');
  }, [selectedTargets, targets]);

  // Background enrichment: businessProfileService.getAccounts() does NOT
  // include the account logo/profile picture — BusinessProfiles.js fetches
  // it per-account via getMediaForLocation. Mirror that behavior so chip
  // avatars show the real business logo instead of a fallback icon.
  // Non-blocking: chips render immediately with placeholder, upgrade in
  // place as each media fetch resolves.
  const enrichProfilesWithMedia = useCallback(async (baseProfiles) => {
    for (const p of baseProfiles) {
      if (p.accountProfilePicture) continue;
      const firstLoc = p.locations?.[0];
      if (!firstLoc) continue;
      const accountId = (p.name || '').split('/').pop();
      const locationId = (firstLoc.name || '').split('/').pop();
      if (!accountId || !locationId) continue;
      try {
        const media = await businessProfileService.getMediaForLocation(accountId, locationId);
        if (!media?.success) continue;
        const pic =
          media.profilePicture ||
          (media.logos && media.logos[0]) ||
          (media.media && media.media.find((m) => m.category === 'PROFILE' || m.category === 'LOGO')) ||
          (media.media && media.media[0]) ||
          null;
        if (pic) {
          setProfiles((prev) => prev.map((pr) => (pr.name === p.name ? { ...pr, accountProfilePicture: pic } : pr)));
        }
      } catch (e) {
        // Non-fatal — chip keeps its fallback icon
      }
    }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      // Use centralized business profile service with caching
      const profilesWithLocations = await businessProfileService.getAccounts();
      setProfiles(profilesWithLocations);
      // Fire-and-forget: enrich with account logos in the background so chip
      // avatars gain real pictures without blocking the initial render.
      enrichProfilesWithMedia(profilesWithLocations);

      // Also fetch FB/IG connections in parallel — they're independent of the
      // GMB OAuth grant, so we should render them even when GMB is empty.
      let social = [];
      try {
        const rows = await connectionsService.list();
        social = (rows || []).filter(r => r.provider === 'facebook' || r.provider === 'instagram');
        setSocialProfiles(social);
      } catch (e) {
        setSocialProfiles([]);
      }

      // Deep-link precedence:
      //   ?social=<connectionId> — pre-select a FB/IG chip
      //   ?location=<gmbPath>    — pre-select a GMB chip
      //   otherwise pre-select the first available target of any kind so the
      //   page isn't in the empty state on load.
      const desiredSocial = searchParams.get('social');
      const desiredLocation = searchParams.get('location');
      const allPaths = profilesWithLocations.flatMap((p) => (p.locations || []).map((l) => l.fullPath));
      const matchedSocial = social.find(r => r.id === desiredSocial);
      if (matchedSocial) {
        setSelectedTargets(new Set([`${matchedSocial.provider === 'facebook' ? 'fb' : 'ig'}:${matchedSocial.id}`]));
      } else if (desiredLocation && allPaths.includes(desiredLocation)) {
        setSelectedTargets(new Set([desiredLocation]));
      } else if (profilesWithLocations.length > 0 && profilesWithLocations[0].locations.length > 0) {
        setSelectedTargets(new Set([profilesWithLocations[0].locations[0].fullPath]));
      } else if (social.length > 0) {
        setSelectedTargets(new Set([`${social[0].provider === 'facebook' ? 'fb' : 'ig'}:${social[0].id}`]));
      }
    } catch (error) {
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  const fetchPosts = useCallback(async (locationId, page = 1, append = false, forceRefresh = false) => {
    if (!locationId) return;

    // Facebook / Instagram branch — hits /api/social/*/posts and returns rows
    // already normalized to { id, content, media[], createdAt } by metaService.
    if (locationId.startsWith('fb:') || locationId.startsWith('ig:')) {
      const connectionId = locationId.slice(3);
      try {
        setRefreshing(true);
        const rows = locationId.startsWith('fb:')
          ? await connectionsService.getFacebookPagePosts(connectionId, 20)
          : await connectionsService.getInstagramMedia(connectionId, 20);
        // Preserve optimistic drafts (from just-published) that haven't yet
        // appeared in the source platform's feed.
        setPosts((prev) => {
          const drafts = prev.filter((p) => p._isDraft);
          const surviving = drafts.filter(
            (d) => !rows.some((fp) => (fp.content || '').trim() === (d.content || '').trim())
          );
          return [...surviving, ...rows];
        });
      } catch (e) {
        setPosts([]);
      } finally {
        setRefreshing(false);
        setLoading(false);
      }
      return;
    }

    try {
      // Extract IDs from the full path: accounts/{accountId}/locations/{locationId}
      const profileParts = locationId.split('/');
      const locationIdOnly = profileParts[profileParts.length - 1];
      const accountId = profileParts[1];
      

      // Use centralized posts service with caching
      const posts = await postsService.getPostsForLocation(locationIdOnly, accountId, forceRefresh);
      
      // Log posts order for debugging
      if (posts && posts.length > 0) {
      }
      
      if (posts && posts.length > 0) {
        // Process media for posts
        const postsWithMedia = await postsService.getMediaForPosts(posts);

        // Preserve optimistic drafts that don't yet appear in the GMB feed.
        setPosts((prev) => {
          const drafts = prev.filter((p) => p._isDraft);
          const surviving = drafts.filter(
            (d) => !postsWithMedia.some((fp) => (fp.content || '').trim() === (d.content || '').trim())
          );
          return [...surviving, ...postsWithMedia];
        });
        
        // Background refresh: check for updates and refresh UI if needed
        if (!forceRefresh) {
          setTimeout(async () => {
            try {
              const freshPosts = await postsService.getPostsForLocation(locationIdOnly, accountId, true);
              
              // Check if data has changed by comparing post IDs and content
              let hasChanges = false;
              
              if (freshPosts.length !== postsWithMedia.length) {
                hasChanges = true;
              } else {
                // Create maps for easier comparison by post ID
                const freshPostsMap = new Map(freshPosts.map(post => [post.id, post]));
                const cachedPostsMap = new Map(postsWithMedia.map(post => [post.id, post]));
                
                // Check if all posts exist and have the same content
                for (const [postId, freshPost] of freshPostsMap) {
                  const cachedPost = cachedPostsMap.get(postId);
                  
                  if (!cachedPost ||
                      freshPost.content !== cachedPost.content ||
                      (freshPost.media?.length || 0) !== (cachedPost.media?.length || 0)) {
                    hasChanges = true;
                    break;
                  }
                }
              }
              
              if (hasChanges) {
                // Process media for fresh posts
                const freshPostsWithMedia = await postsService.getMediaForPosts(freshPosts);
                
                
                setPosts(freshPostsWithMedia);
                
                // Update the cached data with the fresh data
                postsService.setCachedData(`posts_${locationIdOnly}`, freshPosts);
              } else {
              }
            } catch (error) {
            }
          }, 1000); // Wait 1 second after initial render
        }
      } else {
        setPosts([]);
      }

      setRefreshing(false); // Fresh data loaded
      setLoading(false);
    } catch (error) {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {

    if (isAuthenticated && !isDisconnected) {
      // Always fetch data when authenticated (remove business connection check)

      fetchData();
    } else if (isDisconnected) {
      // Clear data when disconnected
      setPosts([]);
      setProfiles([]);
      setLoading(false);
    }
  }, [isAuthenticated, isDisconnected, fetchData]);

  // Multi-target fetch orchestrator. Fans out over every selected chip,
  // tags each returned post with _targetKey/_targetLabel/_targetAccountLabel
  // + _provider so the render layer can badge "Posted to <account>", and
  // merges into one sorted-by-date feed. Preserves optimistic drafts.
  const fetchPostsForTargets = useCallback(async (keys) => {
    if (!keys || keys.length === 0) { setPosts([]); return; }
    setRefreshing(true);
    try {
      const perTarget = await Promise.all(keys.map(async (key) => {
        const target = targets.find((t) => t.key === key);
        const tag = (rows) => rows.map((p) => ({
          ...p,
          _targetKey: key,
          _targetLabel: target?.label,
          _targetAccountLabel: target?.accountLabel,
          // FB/IG posts already carry _provider from the backend normalizer;
          // set it here for GMB too so the render layer can uniformly branch.
          _provider: p._provider || (target?.provider === 'gmb' ? null : target?.provider),
        }));
        try {
          if (key.startsWith('fb:')) {
            const rows = await connectionsService.getFacebookPagePosts(key.slice(3), 10);
            return tag(rows);
          }
          if (key.startsWith('ig:')) {
            const rows = await connectionsService.getInstagramMedia(key.slice(3), 10);
            return tag(rows);
          }
          // GMB
          const parts = key.split('/');
          const locId = parts[parts.length - 1];
          const accId = parts[1];
          const rows = await postsService.getPostsForLocation(locId, accId, false);
          const withMedia = await postsService.getMediaForPosts(rows || []);
          return tag(withMedia || []);
        } catch (e) {
          return [];
        }
      }));
      const flat = perTarget.flat();
      // Sort: newest first. Use createdAt / created_time / timestamp fallbacks.
      flat.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      // Preserve optimistic drafts (drop any whose content matches a fresh post).
      setPosts((prev) => {
        const drafts = prev.filter((p) => p._isDraft);
        const surviving = drafts.filter(
          (d) => !flat.some((fp) => (fp.content || '').trim() === (d.content || '').trim())
        );
        return [...surviving, ...flat];
      });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [targets]);

  // Auto-fetch posts whenever the selection changes.
  useEffect(() => {
    if (!isDisconnected && selectedTargets.size > 0) {
      fetchPostsForTargets([...selectedTargets]);
    } else if (selectedTargets.size === 0) {
      setPosts([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTargets, isDisconnected]);

  const handleCreatePost = async (e) => {
    e.preventDefault();
    setCreatingPost(true);
    setPublishSummary(null);

    // ---- Validate inputs shared across all targets ----
    const validMediaUrls = formData.mediaUrls.filter((url) => url.trim() !== '');
    const invalidUrls = validMediaUrls.filter((url) => {
      try { new URL(url); return false; } catch { return true; }
    });
    if (invalidUrls.length > 0) {
      alert('Please enter valid image URLs for all media files.');
      setCreatingPost(false);
      return;
    }
    if (formData.callToAction.type && formData.callToAction.url) {
      const raw = formData.callToAction.url.trim();
      if (isCallCta(formData.callToAction.type)) {
        if (!looksLikePhone(raw)) {
          alert('Enter a valid phone number for the Call now button (7-15 digits, optional leading +).');
          setCreatingPost(false);
          return;
        }
      } else if (raw) {
        try { new URL(raw); } catch {
          alert('Enter a valid URL for the call to action.');
          setCreatingPost(false);
          return;
        }
      }
    }

    // ---- Fan-out over selectedTargets ----
    const targetKeys = [...selectedTargets];
    if (targetKeys.length === 0) {
      alert('Select at least one account to post to.');
      setCreatingPost(false);
      return;
    }

    const hasIg = targetKeys.some((k) => k.startsWith('ig:'));
    const hasSocial = targetKeys.some((k) => k.startsWith('fb:') || k.startsWith('ig:'));
    const socialImage = validMediaUrls.find((u) => /^https:\/\//i.test(u));
    if (hasIg && !socialImage) {
      alert('Instagram posts require a public HTTPS image URL. Paste one in the media URL field.');
      setCreatingPost(false);
      return;
    }
    if (postingMode === 'later' && hasSocial) {
      alert('Scheduling is not supported for Facebook / Instagram yet. Deselect those chips or switch to "publish now".');
      setCreatingPost(false);
      return;
    }
    if (postingMode === 'later' && uploadedFiles.length > 0) {
      alert('Direct file uploads are not yet supported for scheduled posts — remove the files or paste image URLs instead.');
      setCreatingPost(false);
      return;
    }
    let scheduledWhen = null;
    if (postingMode === 'later') {
      scheduledWhen = new Date(scheduledAt);
      if (Number.isNaN(scheduledWhen.getTime()) || scheduledWhen.getTime() < Date.now() - 60000) {
        alert('Invalid or past scheduled time.');
        setCreatingPost(false);
        return;
      }
    }

    // Build shared media list (used for both GMB and social branches)
    const allMedia = validMediaUrls.map((url) => ({ mediaFormat: 'PHOTO', sourceUrl: url }));

    // ---- Per-target publish. Isolated in Promise.allSettled so one failing
    //      target doesn't block the others. ----
    const publishOne = async (key) => {
      const target = targets.find((t) => t.key === key);
      const label = target ? target.label : key;
      try {
        // Facebook / Instagram
        if (key.startsWith('fb:') || key.startsWith('ig:')) {
          const isIg = key.startsWith('ig:');
          const connectionId = key.slice(3);
          const endpoint = isIg ? '/api/social/instagram/publish' : '/api/social/facebook/publish';
          const body = isIg
            ? { connectionId, caption: formData.summary, imageUrl: socialImage }
            : { connectionId, message: formData.summary, imageUrl: socialImage || undefined };
          await axios.post(endpoint, body);
          return { key, target, label, ok: true };
        }

        // Google Business
        const profileParts = key.split('/');
        const locationId = profileParts[profileParts.length - 1];
        const accountId = profileParts[1];
        if (!accountId || !locationId) throw new Error('Bad GMB target');

        const postData = {
          platforms: ['google'],
          content: formData.summary,
          gmbAccountId: accountId,
          gmbLocationId: locationId,
          postType: formData.postType,
        };
        if (formData.callToAction.type && formData.callToAction.url) {
          postData.callToAction = {
            actionType: formData.callToAction.type,
            url: isCallCta(formData.callToAction.type)
              ? toTelUrl(formData.callToAction.url)
              : formData.callToAction.url.trim(),
          };
        }
        if (formData.postType === 'EVENT') {
          const d = new Date();
          postData.event = {
            title: 'Event',
            schedule: {
              startDate: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
              startTime: { hours: 9, minutes: 0, seconds: 0, nanos: 0 },
              endDate: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
              endTime: { hours: 17, minutes: 0, seconds: 0, nanos: 0 },
            },
          };
        }
        if (allMedia.length > 0) {
          // GMB localPosts.create allows exactly 1 photo — anything more
          // gets rejected as INVALID_ARGUMENT ("Too many photos"). Cap
          // client-side too so the backend never has to truncate.
          postData.media = allMedia.slice(0, 1).map((m) => ({
            mediaFormat: m.mediaFormat || 'PHOTO',
            sourceUrl: m.sourceUrl,
          }));
        }

        if (postingMode === 'later') {
          await calendarService.schedule({
            content: postData.content,
            media: (postData.media || []).map((m) => ({ sourceUrl: m.sourceUrl, mediaFormat: m.mediaFormat || 'PHOTO' })),
            gmbAccountId: accountId,
            gmbLocationId: locationId,
            scheduledTime: scheduledWhen,
            postType: postData.postType,
            callToAction: postData.callToAction || null,
          });
        } else {
          const fd = new FormData();
          fd.append('platforms', JSON.stringify(postData.platforms));
          fd.append('content', postData.content);
          fd.append('gmbAccountId', accountId);
          fd.append('gmbLocationId', locationId);
          fd.append('postType', postData.postType);
          if (postData.callToAction) fd.append('callToAction', JSON.stringify(postData.callToAction));
          if (postData.event) fd.append('event', JSON.stringify(postData.event));
          if (postData.media && postData.media.length > 0) fd.append('media', JSON.stringify(postData.media));
          if (uploadedFiles && uploadedFiles.length > 0) {
            uploadedFiles.forEach((file) => fd.append('images', file));
          }
          // Instrument client-side timing so we can compare what the browser
          // observed vs. what Loki shows for the same request. On timeout,
          // we log the full elapsed ms alongside the file/URL counts.
          const oneStart = Date.now();
          // eslint-disable-next-line no-console
          console.log('[publishOne] POST /api/posts start', {
            key,
            content_length: postData.content.length,
            media_url_count: (postData.media || []).length,
            file_count: uploadedFiles.length,
            postType: postData.postType,
          });
          try {
            await axios.post('/api/posts', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
            // eslint-disable-next-line no-console
            console.log('[publishOne] POST /api/posts ok', { key, elapsed_ms: Date.now() - oneStart });
          } catch (postErr) {
            // eslint-disable-next-line no-console
            console.error('[publishOne] POST /api/posts failed', {
              key,
              elapsed_ms: Date.now() - oneStart,
              code: postErr?.code,
              status: postErr?.response?.status,
              response_data: postErr?.response?.data,
              message: postErr?.message,
            });
            throw postErr;
          }
        }
        return { key, target, label, ok: true };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[publishOne] failed for', key, err);
        const backendMsg = err?.response?.data?.error || err?.response?.data?.details || err.message;
        const needsReauth = err?.response?.data?.needsReauth;
        return { key, target, label, ok: false, error: backendMsg, needsReauth };
      }
    };

    const settled = await Promise.allSettled(targetKeys.map(publishOne));
    const outcomes = settled.map((r) =>
      r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message || 'unknown' }
    );
    const successes = outcomes.filter((o) => o.ok);
    const failures = outcomes.filter((o) => !o.ok);
    setPublishSummary({ successCount: successes.length, failCount: failures.length, failures });

    if (failures.length === 0) {
      showNotification(
        postingMode === 'later'
          ? `Scheduled for ${new Date(scheduledAt).toLocaleString()} on ${successes.length} account${successes.length === 1 ? '' : 's'}`
          : `Posted to ${successes.length} account${successes.length === 1 ? '' : 's'}`,
        'success'
      );
      // If we were editing a saved draft, delete it — the composer has
      // fired successfully so it doesn't need to linger. Non-fatal.
      if (activeDraftId) {
        try { await calendarService.deleteDraft(activeDraftId); } catch { /* non-fatal */ }
        setActiveDraftId(null);
        setDraftSavedAt(null);
        loadSavedDrafts();
      }
      // Remember the CTA URL / phone so the datalist offers it next time.
      if (formData.callToAction.type && formData.callToAction.url?.trim()) {
        if (isCallCta(formData.callToAction.type)) {
          rememberPhone(formData.callToAction.url.trim());
        } else {
          rememberUrl(formData.callToAction.url.trim());
        }
      }
      setFormData({ summary: '', postType: 'UPDATE', callToAction: { type: '', url: '' }, mediaUrls: [''] });
      setUploadedFiles([]);
      setShowComposer(false); // Close the composer modal on full success
    } else if (successes.length === 0) {
      showNotification(
        `Failed on all ${failures.length} account${failures.length === 1 ? '' : 's'}. First error: ${failures[0].error}`,
        'error'
      );
      // Keep modal open so the user can fix + retry
    } else {
      showNotification(
        `Posted to ${successes.length}, failed on ${failures.length}. First failure: ${failures[0].label} — ${failures[0].error}`,
        'success'
      );
      setFormData({ summary: '', postType: 'UPDATE', callToAction: { type: '', url: '' }, mediaUrls: [''] });
      setUploadedFiles([]);
      setShowComposer(false);
    }

    // Optimistic draft: prepend a "publishing" card to the recent posts feed
    // for the currently-focused target IF it was in the success list. Marked
    // with _isDraft so the next fetchPosts can dedupe by content.
    const focusedSuccess = successes.find((o) => o.key === selectedProfile);
    if (focusedSuccess && !editingPost) {
      const focusedTarget = focusedSuccess.target;
      const draftPost = {
        id: `draft-${Date.now()}`,
        content: formData.summary,
        postType: formData.postType,
        createdAt: new Date().toISOString(),
        media: allMedia.map((m) => ({
          mediaFormat: m.mediaFormat || 'PHOTO',
          sourceUrl: m.sourceUrl,
        })),
        callToAction: (formData.callToAction.type && formData.callToAction.url)
          ? { actionType: formData.callToAction.type, url: formData.callToAction.url }
          : null,
        status: 'publishing',
        _isDraft: true,
        _provider: focusedTarget && focusedTarget.provider !== 'gmb' ? focusedTarget.provider : null,
      };
      setPosts((prev) => [draftPost, ...prev]);
    }

    // Refresh the currently focused target's recent posts so the just-published
    // post appears from the source platform (drops the draft placeholder once
    // fetch returns fresh data).
    if (selectedProfile) {
      setTimeout(() => { fetchPostsForTargets([...selectedTargets]); }, 2000);
    }

    setCreatingPost(false);
    setExpandedPosts(new Set());
  };

  const handleDeletePost = async (postId) => {
    // Get post content for confirmation
    const post = posts.find(p => p.id === postId);
    const postContent = post?.content || 'this post';
    
    if (!window.confirm(`Are you sure you want to delete "${postContent.substring(0, 50)}${postContent.length > 50 ? '...' : ''}"?\n\nThis action cannot be undone.`)) return;
    
    try {
      // Set loading state for this specific post
      setDeletingPosts(prev => new Set(prev).add(postId));
      
      // Prefer the post's own _targetKey (tagged during fetchPostsForTargets)
      // so deletion hits the right GMB location when the feed shows posts
      // from multiple targets. Fall back to selectedProfile for backwards
      // compat when _targetKey is missing.
      const originKey = post?._targetKey || selectedProfile;
      const profileParts = (originKey || '').split('/');
      const locationId = profileParts[profileParts.length - 1];
      const accountId = profileParts[1]; // accounts/{accountId}/locations/{locationId}

      if (!accountId || !locationId) {
        alert('Error: Could not determine account or location ID. Please select a different profile.');
        return;
      }

      await axios.delete(`/api/posts/${postId}`, {
        params: {
          gmbAccountId: accountId,
          gmbLocationId: locationId
        }
      });

      // Refresh across all selected targets
      await fetchPostsForTargets([...selectedTargets]);
      showNotification('Post deleted successfully!', 'success');
    } catch (error) {
      if (error.response?.data?.error) {
        showNotification(`Failed to delete post: ${error.response.data.error}`, 'error');
      } else {
        showNotification('Failed to delete post. Please try again.', 'error');
      }
    } finally {
      // Clear loading state
      setDeletingPosts(prev => {
        const newSet = new Set(prev);
        newSet.delete(postId);
        return newSet;
      });
    }
  };


  // Helper function to truncate text to first sentence
  const truncateToFirstSentence = (text, maxLength = 150) => {
    if (!text) return '';
    
    // Find the first sentence (ends with ., !, or ?)
    const firstSentenceMatch = text.match(/^[^.!?]+[.!?]/);
    if (firstSentenceMatch) {
      const firstSentence = firstSentenceMatch[0];
      return firstSentence.length <= maxLength ? firstSentence : firstSentence.substring(0, maxLength) + '...';
    }
    
    // If no sentence ending found, truncate by length
    return text.length <= maxLength ? text : text.substring(0, maxLength) + '...';
  };

     // Helper function to validate URL
   const isValidUrl = (string) => {
     try {
       new URL(string);
       return true;
     } catch (_) {
       return false;
     }
   };

   // Helper function to format date as relative time
   const formatRelativeTime = (dateString) => {
     const date = new Date(dateString);
     const now = new Date();
     const diffInMs = now - date;
     const diffInSeconds = Math.floor(diffInMs / 1000);
     const diffInMinutes = Math.floor(diffInSeconds / 60);
     const diffInHours = Math.floor(diffInMinutes / 60);
     const diffInDays = Math.floor(diffInHours / 24);

     if (diffInDays >= 7) {
       return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
     } else if (diffInDays > 0) {
       return `${diffInDays} day${diffInDays === 1 ? '' : 's'} ago`;
     } else if (diffInHours > 0) {
       return `${diffInHours} hour${diffInHours === 1 ? '' : 's'} ago`;
     } else if (diffInMinutes > 0) {
       return `${diffInMinutes} minute${diffInMinutes === 1 ? '' : 's'} ago`;
     } else {
       return `${diffInSeconds} second${diffInSeconds === 1 ? '' : 's'} ago`;
     }
   };

  // Show notification
  const showNotification = (message, type = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

     // Handle adding uploaded image URL to form
   const handleImageUploaded = (imageUrl) => {
     if (editingPost) {
       setEditFormData(prev => ({
         ...prev,
         mediaUrls: [...prev.mediaUrls, imageUrl]
       }));
     } else {
       setFormData(prev => ({
         ...prev,
         mediaUrls: [...prev.mediaUrls, imageUrl]
       }));
     }
     setUploadingImages(false);
     showNotification('Image uploaded successfully! You can now add it to your post.', 'success');
   };

       // Handle edit post
    const handleEditPost = (post) => {
      setEditingPost(post);
      setEditFormData({
        summary: post.content || '',
        postType: post.postType || 'UPDATE',
        callToAction: {
          type: post.callToAction?.actionType || '',
          url: post.callToAction?.url || ''
        },
        mediaUrls: post.media && post.media.length > 0 
          ? post.media.map(media => media.sourceUrl || media.url || media.thumbnailUrl).filter(Boolean)
          : ['']
      });
    };

   // Handle update post
   const handleUpdatePost = async (e) => {
     e.preventDefault();
     if (!editingPost) return;

     setUpdatingPost(true);
     try {



       
       // Use the post's own _targetKey (set during fetchPostsForTargets) so
       // updates route to the right location when the feed shows posts from
       // multiple GMB locations. Fall back to selectedProfile.
       const originKey = editingPost?._targetKey || selectedProfile;
       const profileParts = (originKey || '').split('/');
       const locationId = profileParts[profileParts.length - 1];
       const accountId = profileParts[1];





       const updateData = {
         content: editFormData.summary,
         postType: editFormData.postType
       };

       // Add call to action only if both type and URL are provided
       if (editFormData.callToAction.type && editFormData.callToAction.type.trim() !== '' && 
           editFormData.callToAction.url && editFormData.callToAction.url.trim() !== '') {
         updateData.callToAction = {
           actionType: editFormData.callToAction.type,
           url: isCallCta(editFormData.callToAction.type)
             ? toTelUrl(editFormData.callToAction.url)
             : editFormData.callToAction.url.trim()
         };
       } else if (editFormData.callToAction.type && editFormData.callToAction.type.trim() !== '') {
         // Warning: CTA type selected but no URL provided
         alert('Warning: You selected a Call to Action type but did not provide a URL. The CTA button will not be displayed.');
       }

       // Add media if provided
       if (editFormData.mediaUrls && editFormData.mediaUrls.length > 0) {
         const validMediaUrls = editFormData.mediaUrls.filter(url => url.trim() !== '');
         if (validMediaUrls.length > 0) {
           updateData.media = validMediaUrls.map(url => ({
             mediaFormat: 'PHOTO',
             sourceUrl: url
           }));
         }
       }



       // Use PATCH request as per GMB API documentation
       try {



         
         const response = await axios.patch(`/api/posts/${editingPost.id}`, updateData, {
           params: {
             gmbAccountId: accountId,
             gmbLocationId: locationId
           }
         });

       } catch (patchError) {



         throw patchError; // Re-throw to be caught by outer catch
       }


       
       // Refresh posts and reset edit state

       try {
         await fetchPostsForTargets([...selectedTargets]);

       } catch (fetchError) {

       }
       

       setEditingPost(null);
       setEditFormData({
         summary: '',
         postType: 'UPDATE',
         callToAction: { type: '', url: '' },
         mediaUrls: ['']
       });
       

       showNotification('Post updated successfully!', 'success');

     } catch (error) {
       showNotification(`Failed to update post: ${error.response?.data?.error || error.message}`, 'error');
     } finally {
       setUpdatingPost(false);
     }
   };

   // Cancel edit
   const handleCancelEdit = () => {
     setEditingPost(null);
     setEditFormData({
       summary: '',
       postType: 'UPDATE',
       callToAction: { type: '', url: '' },
       mediaUrls: ['']
     });
   };

   // ── Saved drafts ─────────────────────────────
   const loadSavedDrafts = useCallback(async () => {
     if (!isAuthenticated || isDisconnected) return;
     setSavedDraftsLoading(true);
     try {
       const data = await calendarService.listDrafts();
       setSavedDrafts(Array.isArray(data.drafts) ? data.drafts : []);
     } catch {
       // non-fatal
     } finally {
       setSavedDraftsLoading(false);
     }
   }, [isAuthenticated, isDisconnected]);

   useEffect(() => {
     loadSavedDrafts();
   }, [loadSavedDrafts]);

   // Save the current composer content as a server-persisted draft.
   // Idempotent: if activeDraftId is set (user opened an existing draft),
   // this updates; otherwise inserts a new row.
   const handleSaveDraft = async () => {
     setSavingDraft(true);
     try {
       const profileParts = (selectedProfile || '').split('/');
       const accountId = profileParts[1] || null;
       const locationId = profileParts[profileParts.length - 1] || null;
       const summary = editingPost ? editFormData.summary : formData.summary;
       const postType = editingPost ? editFormData.postType : formData.postType;
       const cta = editingPost ? editFormData.callToAction : formData.callToAction;
       const mediaUrls = editingPost ? editFormData.mediaUrls : formData.mediaUrls;
       const ctaPayload =
         cta.type && (cta.url || '').trim()
           ? {
               actionType: cta.type,
               url: isCallCta(cta.type) ? toTelUrl(cta.url) : cta.url.trim(),
             }
           : null;
       const payload = {
         content: summary,
         media: (mediaUrls || [])
           .map((u) => (u || '').trim())
           .filter(Boolean)
           .map((sourceUrl) => ({ sourceUrl, mediaFormat: 'PHOTO' })),
         gmbAccountId: accountId,
         gmbLocationId: locationId,
         postType,
         callToAction: ctaPayload,
       };
       let saved;
       if (activeDraftId) {
         saved = await calendarService.updateDraft(activeDraftId, payload);
       } else {
         saved = await calendarService.saveDraft(payload);
         if (saved?.draft?.id) setActiveDraftId(saved.draft.id);
       }
       setDraftSavedAt(new Date());
       loadSavedDrafts();
       showNotification('Draft saved', 'success');
     } catch (err) {
       // Surface the real error (e.g. migration not applied).
       const msg = err?.response?.data?.error || err?.response?.data?.details || err?.message;
       showNotification(`Failed to save draft: ${msg || 'unknown error'}`, 'error');
       // eslint-disable-next-line no-console
       console.error('[handleSaveDraft] failed:', err);
     } finally {
       setSavingDraft(false);
     }
   };

   // Load a saved draft into the composer (formData). Clears any edit-mode.
   const loadDraftIntoComposer = (draft) => {
     setEditingPost(null);
     setActiveDraftId(draft.id);
     const media = Array.isArray(draft.media)
       ? draft.media
           .map((m) => (typeof m === 'string' ? m : m?.sourceUrl || m?.url || ''))
           .filter(Boolean)
       : [];
     const cta = draft.call_to_action || null;
     setFormData({
       summary: draft.content || '',
       postType: draft.post_type || 'UPDATE',
       callToAction: {
         type: cta?.actionType || '',
         url: cta?.actionType === 'CALL' ? (cta.url || '').replace(/^tel:/i, '') : (cta?.url || ''),
       },
       mediaUrls: media.length > 0 ? media : [''],
     });
     if (draft.gmb_account_id && draft.location_id) {
       setSelectedProfile(`accounts/${draft.gmb_account_id}/locations/${draft.location_id}`);
     }
     // Scroll composer into view for good UX.
     setTimeout(() => {
       const el = document.getElementById('post-composer');
       if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
     }, 50);
   };

   const deleteSavedDraft = async (id) => {
     // eslint-disable-next-line no-restricted-globals, no-alert
     if (!window.confirm('Delete this draft?')) return;
     try {
       await calendarService.deleteDraft(id);
       setSavedDrafts((prev) => prev.filter((d) => d.id !== id));
       if (activeDraftId === id) setActiveDraftId(null);
     } catch { /* non-fatal */ }
   };

   const clearDraftBinding = () => {
     setActiveDraftId(null);
     setDraftSavedAt(null);
   };

   // Handle delete image from preview
   const handleDeleteImage = (index) => {
     if (editingPost) {
       setEditFormData(prev => {
         const newUrls = prev.mediaUrls.filter((_, i) => i !== index);
         // Ensure there's always at least one empty string for the form
         return {
           ...prev,
           mediaUrls: newUrls.length === 0 ? [''] : newUrls
         };
       });
     } else {
       setFormData(prev => {
         const newUrls = prev.mediaUrls.filter((_, i) => i !== index);
         // Ensure there's always at least one empty string for the form
         return {
           ...prev,
           mediaUrls: newUrls.length === 0 ? [''] : newUrls
         };
       });
    }
    showNotification('Image removed from preview', 'success');
  };

  // Handle file upload
  const handleFileUpload = (event) => {
    const files = Array.from(event.target.files);
    setUploadedFiles(prev => [...prev, ...files]);
  };

  // Handle remove uploaded file
  const removeUploadedFile = (index) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // ── Drive picker + AI (shared with Calendar composer) ──
  const currentMediaUrls = () => {
    const fd = editingPost ? editFormData : formData;
    return (fd.mediaUrls || []).map((u) => (u || '').trim()).filter(Boolean);
  };

  const setMediaUrlsOnActive = (updater) => {
    if (editingPost) {
      setEditFormData((prev) => ({ ...prev, mediaUrls: updater(prev.mediaUrls || []) }));
    } else {
      setFormData((prev) => ({ ...prev, mediaUrls: updater(prev.mediaUrls || []) }));
    }
  };

  const handleDrivePicked = (picked) => {
    setMediaUrlsOnActive((prev) => {
      const next = [...prev];
      for (const url of picked) {
        if (next.includes(url)) continue;
        const emptyIdx = next.findIndex((v) => !v || !v.trim());
        if (emptyIdx >= 0) next[emptyIdx] = url;
        else next.push(url);
      }
      return next;
    });
    setDrivePickerOpen(false);
  };

  const handleGenerateAi = async () => {
    setAiError(null);
    setAiJustFilled(false);
    const urls = currentMediaUrls();
    if (urls.length === 0) {
      setAiError('Add at least one image URL first — the AI writes the caption from what it sees.');
      return;
    }
    // Pull business context from the currently-selected profile so the
    // caption sounds grounded in the actual business.
    const profileParts = (selectedProfile || '').split('/');
    const targetAccountId = profileParts[1];
    const targetLocationId = profileParts[profileParts.length - 1];
    let businessName = 'the business';
    let businessType = 'local service business';
    let city = '';
    for (const p of profiles) {
      const accId = p?.name?.split('/').pop();
      if (accId !== targetAccountId) continue;
      const loc = (p.locations || []).find(
        (l) => (l?.name?.split('/').pop() || l?.fullPath?.split('/').pop()) === targetLocationId
      );
      if (loc) {
        businessName = loc.title || loc.locationName || p.accountName || businessName;
        businessType =
          loc.primaryCategory?.displayName ||
          loc.categories?.primaryCategory?.displayName ||
          businessType;
        city = loc.storefrontAddress?.locality || loc.address?.locality || '';
      }
      break;
    }

    setAiGenerating(true);
    setAiImageDescriptions([]);
    const currentPostType = editingPost ? editFormData.postType : formData.postType;
    const currentCta = editingPost ? editFormData.callToAction : formData.callToAction;
    try {
      const resp = await axios.post(
        '/api/ai/post-from-image',
        {
          imageUrls: urls.slice(0, 10),
          businessName,
          businessType,
          city,
          postType: currentPostType,
          includeCallToAction: !!currentCta.type,
          ctaType: currentCta.type || null,
        },
        { timeout: 120000 }
      );
      if (resp.data?.text) {
        if (editingPost) {
          setEditFormData((prev) => ({ ...prev, summary: resp.data.text }));
        } else {
          setFormData((prev) => ({ ...prev, summary: resp.data.text }));
        }
        setAiJustFilled(true);
        setAiImageDescriptions(Array.isArray(resp.data.imageDescriptions) ? resp.data.imageDescriptions : []);
      } else {
        setAiError('AI returned an empty response — try again or edit manually.');
      }
    } catch (err) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.error || err?.message;
      if (status === 429) {
        setAiError(`Daily AI cap reached (${err?.response?.data?.used}/${err?.response?.data?.cap}).`);
      } else {
        setAiError(detail || 'AI generation failed');
      }
    } finally {
      setAiGenerating(false);
    }
  };


  // Toggle expanded state for a post
  const toggleExpanded = (postId) => {
    setExpandedPosts(prev => {
      const newSet = new Set(prev);
      if (newSet.has(postId)) {
        newSet.delete(postId);
      } else {
        newSet.add(postId);
      }
      return newSet;
    });
  };

  const getPostTypeIcon = (type) => {
    switch (type) {
      case 'UPDATE':
        return <FileText className="h-4 w-4" />;
      case 'OFFER':
        return <FileText className="h-4 w-4" />;
      case 'EVENT':
        return <Calendar className="h-4 w-4" />;
      case 'PRODUCT':
        return <FileText className="h-4 w-4" />;
      default:
        return <FileText className="h-4 w-4" />;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'published':
        return 'bg-green-100 text-green-800';
      case 'draft':
        return 'bg-gray-100 text-gray-800';
      case 'scheduled':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-gray-500">Please log in to view posts</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6" style={{
      '--tw-ring-color': 'rgb(59 130 246 / 1)',
      '--tw-ring-opacity': '1'
    }}>
      {/* Notification */}
      {notification && (
        <div className={`p-4 rounded-md ${
          notification.type === 'success' 
            ? 'bg-green-50 border border-green-200 text-green-800' 
            : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          <div className="flex items-center justify-between">
            <span>{notification.message}</span>
            <button
              onClick={() => setNotification(null)}
              className="text-gray-400 hover:text-gray-600"
            >
              ×
            </button>
            </div>
        </div>
      )}
      
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Posts</h1>
          <p className="mt-1 text-sm text-gray-500">
            Create and manage posts for your business profiles
          </p>
        </div>
        <div className="flex space-x-3">
          <button
            onClick={() => {
              setEditingPost(null);
              setShowComposer(true);
            }}
            className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Post
          </button>
          <button
            onClick={() => {
              fetchPostsForTargets([...selectedTargets]);
            }}
            disabled={refreshing}
            className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh Posts
          </button>
          <button
            onClick={async () => {
              try {
                setRefreshing(true);
                // Clear GMB cache once (FB/IG don't cache client-side) then
                // re-fan-out across every selected target.
                postsService.clearPostsCache();
                postsService.clearMediaCache();
                await fetchPostsForTargets([...selectedTargets]);
              } catch (error) {
              } finally {
                setRefreshing(false);
              }
            }}
            disabled={refreshing}
            className="inline-flex items-center px-4 py-2 border border-blue-300 shadow-sm text-sm font-medium rounded-md text-blue-700 bg-blue-50 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh All Posts
          </button>
        </div>
      </div>

      {/* Multi-select target chip picker. Each chip is an avatar + platform
          badge; click toggles it in selectedTargets. Selected chips get a
          colored ring + checkmark. "Select All" flips the whole set. */}
      <TargetChipsPicker
        targets={targets}
        selected={selectedTargets}
        onChange={(nextSet) => {
          setSelectedTargets(nextSet);
          setExpandedPosts(new Set()); // Reset expanded posts on selection change
        }}
      />

      {/* Drafts strip: click a draft to open in composer, prefilled. Empty
          state hidden entirely to keep the Posts page clean when there are
          no drafts. */}
      {savedDrafts.length > 0 && (
        <div className="bg-white shadow rounded-lg p-4 border border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-900">
              Drafts <span className="font-normal text-gray-500">({savedDrafts.length})</span>
            </h3>
            <button
              type="button"
              onClick={loadSavedDrafts}
              disabled={savedDraftsLoading}
              className="text-xs text-primary-600 hover:underline disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 inline ${savedDraftsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <ul className="divide-y divide-gray-100">
            {savedDrafts.map((d) => {
              const isActive = d.id === activeDraftId;
              const preview = (d.content || '').trim();
              return (
                <li key={d.id} className={`group flex items-start gap-2 py-2 ${isActive ? 'bg-primary-50/40' : ''}`}>
                  <button
                    type="button"
                    onClick={() => { setShowComposer(true); loadDraftIntoComposer(d); }}
                    className="flex-1 min-w-0 text-left"
                    title="Open in composer"
                  >
                    <span className="block text-sm text-gray-900 truncate">
                      {preview ? preview.slice(0, 100) : <span className="italic text-gray-400">(empty)</span>}
                    </span>
                    <span className="block text-[11px] text-gray-500">
                      {new Date(d.updated_at || d.created_at).toLocaleString()}
                      {Array.isArray(d.media) && d.media.length > 0 ? ` · ${d.media.length} image${d.media.length === 1 ? '' : 's'}` : ''}
                      {isActive ? ' · editing' : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSavedDraft(d.id)}
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1"
                    title="Delete draft"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Composer modal — opens on "New Post" click or when editingPost is set.
          Backdrop click closes it (unless a submit is in flight). Wraps the
          existing composer JSX unchanged; only adds the overlay + close X. */}
      {(showComposer || editingPost) && (
      <div
        className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
        onClick={() => { if (!creatingPost && !updatingPost) { setShowComposer(false); setEditingPost(null); } }}
      >
       <div id="post-composer" className="max-w-4xl w-full my-8 relative" onClick={(e) => e.stopPropagation()}>
         <button
           type="button"
           onClick={() => { if (!creatingPost && !updatingPost) { setShowComposer(false); setEditingPost(null); } }}
           className="absolute -top-3 -right-3 h-8 w-8 rounded-full bg-white shadow-md text-gray-500 hover:text-gray-700 flex items-center justify-center z-10"
           title="Close"
         >
           <X className="h-4 w-4" />
         </button>
       <div className="bg-white shadow rounded-lg p-6">
         <div className="flex items-center justify-between mb-4">
                       <div>
              <h2 className="text-lg font-medium text-gray-900">
                {editingPost ? 'Edit Post' : 'New Post'}
              </h2>
              {/* Explicit "where will this post go" indicator right under
                  the modal title so users don't have to guess which chips
                  were selected before opening the composer. */}
              {!editingPost && (() => {
                const chosen = targets.filter((t) => selectedTargets.has(t.key));
                if (chosen.length === 0) {
                  return (
                    <div className="mt-1 text-xs text-amber-700">
                      No profiles selected — pick at least one behind the composer before posting.
                    </div>
                  );
                }
                return (
                  <div className="mt-1 text-sm text-gray-700">
                    <span className="font-medium">
                      Posting to {chosen.length} account{chosen.length === 1 ? '' : 's'}:
                    </span>{' '}
                    <span className="text-gray-900">
                      {chosen
                        .map((t) => t.label || t.title || t.locationName || 'Unnamed')
                        .join(', ')}
                    </span>
                  </div>
                );
              })()}
            </div>
           <div className="flex items-center space-x-4">
             {/* Post Type Selection Buttons */}
             <div className="flex items-center space-x-2">
               <span className="text-sm font-medium text-gray-700">Post Type:</span>
               <div className="flex bg-gray-100 rounded-lg p-1">
                 <button
                   type="button"
                   onClick={() => {
                     if (editingPost) {
                       setEditFormData({ ...editFormData, postType: 'UPDATE' });
                     } else {
                       setFormData({ ...formData, postType: 'UPDATE' });
                     }
                   }}
                   className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                     (editingPost ? editFormData.postType : formData.postType) === 'UPDATE'
                       ? 'bg-white text-gray-900 shadow-sm'
                       : 'text-gray-600 hover:text-gray-900'
                   }`}
                 >
                   Update
                 </button>
                 <button
                   type="button"
                   onClick={() => {
                     if (editingPost) {
                       setEditFormData({ ...editFormData, postType: 'OFFER' });
                     } else {
                       setFormData({ ...formData, postType: 'OFFER' });
                     }
                   }}
                   className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                     (editingPost ? editFormData.postType : formData.postType) === 'OFFER'
                       ? 'bg-white text-gray-900 shadow-sm'
                       : 'text-gray-600 hover:text-gray-900'
                   }`}
                 >
                   Offer
                 </button>
                 <button
                   type="button"
                   onClick={() => {
                     if (editingPost) {
                       setEditFormData({ ...editFormData, postType: 'EVENT' });
                     } else {
                       setFormData({ ...formData, postType: 'EVENT' });
                     }
                   }}
                   className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                     (editingPost ? editFormData.postType : formData.postType) === 'EVENT'
                       ? 'bg-white text-gray-900 shadow-sm'
                       : 'text-gray-600 hover:text-gray-900'
                   }`}
                 >
                   Event
                 </button>
               </div>
             </div>
             
             {editingPost && (
               <button
                 onClick={handleCancelEdit}
                 className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200"
               >
                 Cancel Edit
               </button>
             )}
           </div>
         </div>
        
                 <form onSubmit={editingPost ? handleUpdatePost : handleCreatePost}>
           {/* When: publish immediately or schedule (matches Calendar composer).
               Hidden while editing an existing post — schedule vs publish
               only applies to new drafts. */}
           {!editingPost && (
             <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
               <span className="text-sm font-medium text-gray-700">When:</span>
               <div className="flex items-center gap-1">
                 <button
                   type="button"
                   onClick={() => setPostingMode('now')}
                   className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                     postingMode === 'now'
                       ? 'bg-primary-600 text-white border-primary-600'
                       : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                   }`}
                 >
                   Publish now
                 </button>
                 <button
                   type="button"
                   onClick={() => setPostingMode('later')}
                   className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                     postingMode === 'later'
                       ? 'bg-primary-600 text-white border-primary-600'
                       : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                   }`}
                 >
                   Schedule for later
                 </button>
               </div>
               {postingMode === 'later' && (
                 <input
                   type="datetime-local"
                   value={scheduledAt}
                   onChange={(e) => setScheduledAt(e.target.value)}
                   className="block sm:w-auto border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
                 />
               )}
             </div>
           )}
           {/* Target chip picker was moved to just above the footer
               (right before Publish/Schedule) so users see where they're
               posting in the same viewport as the action button. */}
           <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
             {/* Left Column - Form */}
             <div className="lg:col-span-2 space-y-4">
               {/* Picture Upload Section - Moved to Top */}
               <div>
                 <label className="block text-sm font-medium text-gray-700 mb-2">
                   Add Pictures
                   <span className="ml-2 text-xs font-normal text-gray-500">
                     (Google Business Profile posts only allow 1 photo — extras are ignored)
                   </span>
                 </label>
                 
                 {/* File Upload Section */}
                 <div className="mb-4 space-y-4">
                   {/* Direct File Upload */}
                   <div>
                     <label className="block text-sm font-medium text-gray-700 mb-2">
                       Upload Image Files (Direct to Database)
                     </label>
                     <input
                       type="file"
                       multiple
                       accept="image/*"
                       onChange={handleFileUpload}
                       className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
                     />
                     {uploadedFiles.length > 0 && (
                       <div className="mt-2">
                         <p className="text-sm text-gray-600">
                           Selected files: {uploadedFiles.length}
                         </p>
                         <div className="flex flex-wrap gap-2 mt-1">
                           {uploadedFiles.map((file, index) => (
                             <span
                               key={index}
                               className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800"
                             >
                               {file.name}
                               <button
                                 type="button"
                                 onClick={() => removeUploadedFile(index)}
                                 className="ml-1 text-green-600 hover:text-green-800"
                               >
                                 ×
                               </button>
                             </span>
                           ))}
                         </div>
                       </div>
                     )}
                   </div>

                   {/* ImgBB URL Upload (for backward compatibility) */}
                   <div>
                     <label className="block text-sm font-medium text-gray-700 mb-2">
                       Upload via URL (ImgBB Service)
                     </label>
                     <div className="hidden">
                       <ImageUploader 
                         onImageUploaded={handleImageUploaded}
                       />
                     </div>
                     <button
                       type="button"
                       disabled={uploadingImages}
                       onClick={() => {
                         setUploadingImages(true);
                         // Trigger the hidden file input from ImageUploader
                         const fileInput = document.querySelector('input[type="file"]');
                         if (fileInput) {
                           fileInput.click();
                         }
                       }}
                       className={`inline-flex items-center px-4 py-3 border border-primary-300 shadow-sm text-sm font-medium rounded-md transition-colors duration-200 ${
                         uploadingImages
                           ? 'text-primary-500 bg-primary-25 cursor-not-allowed'
                           : 'text-primary-700 bg-primary-50 hover:bg-primary-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500'
                       }`}
                     >
                       {uploadingImages ? (
                         <>
                           <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-500 mr-2"></div>
                           Uploading Images...
                         </>
                       ) : (
                         <>
                           <Plus className="h-5 w-5 mr-2" />
                           Upload Images via URL
                         </>
                       )}
                     </button>
                   </div>

                   {/* Google Drive picker — same as the Calendar composer */}
                   <div>
                     <label className="block text-sm font-medium text-gray-700 mb-2">
                       Pick from Google Drive
                     </label>
                     <button
                       type="button"
                       onClick={() => setDrivePickerOpen(true)}
                       className="inline-flex items-center px-4 py-3 border border-primary-300 shadow-sm text-sm font-medium rounded-md text-primary-700 bg-primary-50 hover:bg-primary-100"
                     >
                       <HardDrive className="h-5 w-5 mr-2" />
                       Browse Drive
                     </button>
                     <p className="mt-1 text-xs text-gray-500">
                       Browse folders across every connected Google account. Duplicates are flagged.
                     </p>
                   </div>
                 </div>


               </div>

                               {/* Description Section */}
                <div>
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium text-gray-700">
                      Description
                      <span className="text-gray-500 font-normal ml-2">
                        ({(editingPost ? editFormData.summary : formData.summary).length}/1500)
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={handleGenerateAi}
                      disabled={aiGenerating || currentMediaUrls().length === 0}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                        aiGenerating || currentMediaUrls().length === 0
                          ? 'text-gray-400 border-gray-200 bg-white cursor-not-allowed'
                          : 'text-primary-700 border-primary-300 bg-primary-50 hover:bg-primary-100'
                      }`}
                      title={
                        currentMediaUrls().length === 0
                          ? 'Add at least one image URL to generate a caption from it'
                          : 'Write a caption from the selected image(s)'
                      }
                    >
                      <Sparkles className={`h-3.5 w-3.5 ${aiGenerating ? 'animate-pulse' : ''}`} />
                      {aiGenerating
                        ? 'Generating…'
                        : (editingPost ? editFormData.summary : formData.summary)
                        ? 'Regenerate with AI'
                        : 'Generate with AI'}
                    </button>
                  </div>
                  <textarea
                    value={editingPost ? editFormData.summary : formData.summary}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value.length <= 1500) {
                        if (editingPost) {
                          setEditFormData({ ...editFormData, summary: value });
                        } else {
                          setFormData({ ...formData, summary: value });
                        }
                      }
                    }}
                    rows={4}
                    maxLength={1500}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                    placeholder="Write your post content here..."
                    required
                  />
                  <div className="mt-1 text-xs text-gray-500 text-right">
                    {(editingPost ? editFormData.summary : formData.summary).length}/1500 characters
                  </div>
                  {aiError && (
                    <p className="mt-1 text-xs text-red-700">{aiError}</p>
                  )}
                  {aiJustFilled && (
                    <p className="mt-1 text-xs text-primary-700">
                      ✨ AI-generated from your image{currentMediaUrls().length > 1 ? 's' : ''} — edit before posting if anything is off.
                    </p>
                  )}
                  {aiImageDescriptions.length > 0 && (
                    <details className="mt-2 rounded-md border border-gray-200 bg-gray-50">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-700 select-none">
                        What the AI saw ({aiImageDescriptions.length} image{aiImageDescriptions.length === 1 ? '' : 's'})
                      </summary>
                      <ul className="px-3 pb-3 pt-1 space-y-1 text-xs text-gray-700">
                        {aiImageDescriptions.map((desc, i) => (
                          <li key={i}>
                            <span className="font-medium text-gray-500">Image {i + 1}:</span> {desc}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>

                               {/* Post Type Section - Hidden since we have buttons above */}
                <div className="hidden">
                  <label className="block text-sm font-medium text-gray-700">Post Type</label>
                  <select
                    value={editingPost ? editFormData.postType : formData.postType}
                    onChange={(e) => editingPost
                      ? setEditFormData({ ...editFormData, postType: e.target.value })
                      : setFormData({ ...formData, postType: e.target.value })
                    }
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  >
                    <option value="UPDATE">Update</option>
                    <option value="OFFER">Offer</option>
                    <option value="EVENT">Event</option>
                    <option value="PRODUCT">Product</option>
                  </select>
                </div>

               {/* Call to Action Type — labels match Google Business Profile Add-post UI */}
               <div>
                 <label className="block text-sm font-medium text-gray-700">Call to Action Type</label>
                 <select
                   value={editingPost ? editFormData.callToAction.type : formData.callToAction.type}
                   onChange={(e) => {
                     const nextType = e.target.value;
                     const prev = editingPost ? editFormData.callToAction : formData.callToAction;
                     // Clear the URL/phone value when switching between phone- and
                     // URL-shaped inputs — the old value won't validate as the new
                     // kind and only confuses the user.
                     const switching = isCallCta(prev.type) !== isCallCta(nextType);
                     const nextCta = { type: nextType, url: switching ? '' : prev.url };
                     if (editingPost) {
                       setEditFormData({ ...editFormData, callToAction: nextCta });
                     } else {
                       setFormData({ ...formData, callToAction: nextCta });
                     }
                   }}
                   className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                 >
                   {CTA_OPTIONS.map((o) => (
                     <option key={o.v || 'none'} value={o.v}>
                       {o.label}
                     </option>
                   ))}
                 </select>
               </div>

               {/* Call to Action URL or Phone Number */}
               {(editingPost ? editFormData.callToAction.type : formData.callToAction.type) && (
                 <div>
                   <label className="block text-sm font-medium text-gray-700">
                     {isCallCta(editingPost ? editFormData.callToAction.type : formData.callToAction.type)
                       ? 'Phone number'
                       : 'Call to Action URL'}
                   </label>
                   <input
                     type={
                       isCallCta(editingPost ? editFormData.callToAction.type : formData.callToAction.type)
                         ? 'tel'
                         : 'url'
                     }
                     list={
                       isCallCta(editingPost ? editFormData.callToAction.type : formData.callToAction.type)
                         ? 'cta-phone-history'
                         : 'cta-url-history'
                     }
                     value={editingPost ? editFormData.callToAction.url : formData.callToAction.url}
                     onChange={(e) => editingPost
                       ? setEditFormData({
                           ...editFormData,
                           callToAction: { ...editFormData.callToAction, url: e.target.value }
                         })
                       : setFormData({
                           ...formData,
                           callToAction: { ...formData.callToAction, url: e.target.value }
                         })
                     }
                     className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                     placeholder={
                       isCallCta(editingPost ? editFormData.callToAction.type : formData.callToAction.type)
                         ? '(904) 902-0402'
                         : 'https://example.com'
                     }
                   />
                   {/* Datalists give the browser native autocomplete from
                       previously-used URLs/phones. Populated from
                       composerMemory on every successful submit. */}
                   <datalist id="cta-url-history">
                     {getRecentUrls().map((u) => (
                       <option key={u} value={u} />
                     ))}
                   </datalist>
                   <datalist id="cta-phone-history">
                     {getRecentPhones().map((p) => (
                       <option key={p} value={p} />
                     ))}
                   </datalist>
                   <p className="mt-1 text-xs text-gray-500">
                     {isCallCta(editingPost ? editFormData.callToAction.type : formData.callToAction.type)
                       ? 'Customers will call this number when they tap the button.'
                       : 'Where the button sends people when tapped.'}
                   </p>
                 </div>
               )}

               {/* Target chip picker — placed here so it's right above the
                   Publish/Schedule buttons in the same viewport. Users see
                   which accounts they're posting to at the moment of action. */}
               {!editingPost && targets.length > 0 && (
                 <div className="mt-4 border border-gray-200 rounded-lg p-3 bg-gray-50/50">
                   <TargetChipsPicker
                     targets={targets}
                     selected={selectedTargets}
                     onChange={(nextSet) => {
                       setSelectedTargets(nextSet);
                       setExpandedPosts(new Set());
                     }}
                   />
                 </div>
               )}

               {/* Submit Button */}
               <div className="flex justify-between items-center pt-4">
                 <div className="text-xs text-gray-500 flex items-center gap-3">
                   {activeDraftId && (
                     <span className="inline-flex items-center gap-1 text-primary-700">
                       Editing draft
                       <button
                         type="button"
                         onClick={clearDraftBinding}
                         className="text-gray-400 hover:text-gray-700 text-[10px] uppercase"
                         title="Unlink from draft (creates a new draft on next save)"
                       >
                         (unlink)
                       </button>
                     </span>
                   )}
                   {draftSavedAt && (
                     <span>Saved {draftSavedAt.toLocaleTimeString()}</span>
                   )}
                 </div>
                 <div className="flex items-center gap-2">
                   {!editingPost && (
                     <button
                       type="button"
                       onClick={handleSaveDraft}
                       disabled={savingDraft || creatingPost}
                       className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-60"
                     >
                       {savingDraft
                         ? 'Saving…'
                         : activeDraftId
                         ? 'Update draft'
                         : 'Save as draft'}
                     </button>
                   )}
                   <button
                     type="submit"
                     disabled={creatingPost || updatingPost}
                     className={`px-8 py-3 border border-transparent rounded-md shadow-sm text-sm font-medium text-white transition-colors duration-200 ${
                       (creatingPost || updatingPost)
                         ? 'bg-primary-400 cursor-not-allowed'
                         : 'bg-primary-600 hover:bg-primary-700'
                     }`}
                   >
                     {creatingPost ? (
                       <>
                         <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2 inline-block"></div>
                         {postingMode === 'later' ? 'Scheduling…' : 'Creating Post...'}
                       </>
                     ) : updatingPost ? (
                       <>
                         <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2 inline-block"></div>
                         Updating Post...
                       </>
                     ) : (
                       editingPost
                         ? 'Update Post'
                         : postingMode === 'later'
                         ? 'Schedule Post'
                         : 'Create Post'
                     )}
                   </button>
                 </div>
               </div>
             </div>

             {/* Right Column - Post Preview */}
             <div className="lg:col-span-1">
               <div className="sticky top-6">
                 <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                   <h3 className="text-lg font-medium text-gray-900 mb-4">Post Preview</h3>
                   
                   {/* Preview Content */}
                   <div className="space-y-4">
                                           {/* Image Preview */}
                      <div>
                        <h4 className="text-sm font-medium text-gray-700 mb-2"></h4>
                       {(editingPost ? editFormData.mediaUrls : formData.mediaUrls).filter(url => url.trim() !== '').length > 0 ? (
                         <div className="space-y-3">
                           {(editingPost ? editFormData.mediaUrls : formData.mediaUrls)
                             .filter(url => url.trim() !== '')
                             .slice(0, 2) // Show only first 2 images in preview
                             .map((url, index) => (
                               <div key={`preview-${index}`} className="relative group">
                                 {/* Drive-aware preview: auth'd proxy for
                                     Drive URLs so files that haven't been
                                     publicly shared still render. */}
                                 <SmartPreviewImage
                                   url={url}
                                   alt={`Preview ${index + 1}`}
                                   className="w-full h-56 object-cover rounded-lg border shadow-sm"
                                 />
                                 {/* Delete Button */}
                                 <button
                                   onClick={() => handleDeleteImage(index)}
                                   className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center transition-colors duration-200"
                                   title="Delete image"
                                 >
                                   ×
                                 </button>
                               </div>
                             ))}
                           {(editingPost ? editFormData.mediaUrls : formData.mediaUrls).filter(url => url.trim() !== '').length > 2 && (
                             <div className="text-xs text-gray-500 text-center py-2">
                               +{(editingPost ? editFormData.mediaUrls : formData.mediaUrls).filter(url => url.trim() !== '').length - 2} more images
                             </div>
                           )}
                         </div>
                       ) : (
                         <div className="w-full h-48 bg-gray-200 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center">
                           <div className="text-center">
                             <div className="text-gray-400 text-4xl mb-2">📷</div>
                             <p className="text-xs text-gray-500">No images uploaded</p>
                           </div>
                         </div>
                       )}
                     </div>

                     {/* Content Preview */}
                     <div>
                       {(editingPost ? editFormData.summary : formData.summary) ? (
                         <p className="text-sm text-gray-900 leading-relaxed">
                           {(editingPost ? editFormData.summary : formData.summary).length > 150 
                             ? `${(editingPost ? editFormData.summary : formData.summary).substring(0, 150)}...` 
                             : (editingPost ? editFormData.summary : formData.summary)
                           }
                         </p>
                                               ) : (
                          <p className="text-sm text-gray-900 italic">No content yet</p>
                        )}
                     </div>

                                           {/* Call to Action Link Preview */}
                      <div className="space-y-2">
                        <div>
                          <h4 className="text-sm font-medium text-gray-500 mb-2">
                            {(postingMode === 'later' && scheduledAt
                              ? new Date(scheduledAt)
                              : new Date()
                            ).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </h4>
                                                   {(editingPost ? editFormData.callToAction.type : formData.callToAction.type) ? (
                            <a
                              href={(editingPost ? editFormData.callToAction.url : formData.callToAction.url) || '#'}
                              className={`text-primary-600 hover:text-primary-700 text-sm font-medium ${
                                !(editingPost ? editFormData.callToAction.url : formData.callToAction.url) ? 'pointer-events-none' : ''
                              }`}
                            >
                              {(editingPost ? editFormData.callToAction.type : formData.callToAction.type).charAt(0).toUpperCase() + (editingPost ? editFormData.callToAction.type : formData.callToAction.type).slice(1).toLowerCase()}
                            </a>
                          ) : (
                            <span className="text-sm text-gray-400 italic">No CTA</span>
                          )}
                       </div>
                     </div>
                   </div>
                 </div>
               </div>
             </div>
           </div>
         </form>
      </div>
      </div>
      </div>
      )}

      {/* Posts List */}
      {selectedTargets.size > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium text-gray-900">Posts</h2>
              {refreshing && (
                <div className="flex items-center text-sm text-blue-600">
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Refreshing...
                </div>
              )}
            </div>
            <button
              onClick={() => {
                setExpandedPosts(new Set()); // Reset expanded posts when refreshing
                fetchPostsForTargets([...selectedTargets]); // Re-fan-out across all selected
              }}
              className="inline-flex items-center px-3 py-1 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
            >
              <Clock className="h-4 w-4 mr-1" />
              Refresh Posts
            </button>
          </div>
          <div className="p-6">
            {posts.length > 0 ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
                  {posts.map((post, index) => {








                     if (post.media && post.media.length > 0) {



                     }
                     
                     // Additional CTA debugging
                     if (post.callToAction) {





                     }

                     
                     return (
                       <div key={`${post.id}-${post.createdAt}`} className="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow duration-200 overflow-hidden">
                      {/* Post Header — provider badge (for FB/IG) + edit/delete
                          (GMB only; Meta post edit/delete isn't wired yet). */}
                      <div className="flex items-center justify-between p-3 bg-gray-50">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          {post._isDraft && (
                            <span className="inline-flex items-center text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                              <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                              Publishing…
                            </span>
                          )}
                          {/* Provider badge (platform) */}
                          {post._provider === 'facebook' && (
                            <span className="inline-flex items-center text-xs px-2 py-0.5 rounded bg-indigo-100 text-indigo-800">
                              <Facebook className="h-3 w-3 mr-1" />
                              Facebook
                            </span>
                          )}
                          {post._provider === 'instagram' && (
                            <span className="inline-flex items-center text-xs px-2 py-0.5 rounded bg-pink-100 text-pink-800">
                              <Instagram className="h-3 w-3 mr-1" />
                              Instagram
                            </span>
                          )}
                          {!post._provider && (
                            <span className="inline-flex items-center text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                              <Building2 className="h-3 w-3 mr-1" />
                              Google
                            </span>
                          )}
                          {/* Which account this post was published to.
                              Always show — even for single-account view,
                              users want to see WHERE it was posted. */}
                          {post._targetLabel && (
                            <span className="inline-flex items-center text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700 truncate max-w-[180px]" title={post._targetLabel}>
                              {post._targetLabel}
                            </span>
                          )}
                        </div>
                        {/* Action Buttons — hidden for FB/IG posts because
                            edit/delete via Graph API isn't implemented yet.
                            Users can jump to the post on Meta via permalink. */}
                        <div className="flex items-center space-x-2">
                          {post._provider ? (
                            post.permalink && (
                              <a
                                href={post.permalink}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700"
                                title="Open on Meta"
                              >
                                <Eye className="h-4 w-4" />
                                Open
                              </a>
                            )
                          ) : (
                            <>
                              {/* Open the post on Google Search. GMB no
                                  longer exposes stable /n/<acct>/l/<loc>
                                  URLs (returns 400) and there's no public
                                  per-post permalink, so we google the
                                  business name — the Business Profile
                                  panel that pops up on the results page
                                  includes the "Updates" (posts) section. */}
                              {(post._targetLabel || post._businessName) && (
                                <a
                                  href={`https://www.google.com/search?q=${encodeURIComponent(post._targetLabel || post._businessName)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-gray-400 hover:text-primary-600 p-1 rounded hover:bg-gray-100"
                                  title="Open on Google Search"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </a>
                              )}
                              <button
                                onClick={() => handleEditPost(post)}
                                className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
                                title="Edit post"
                              >
                                <Edit className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => handleDeletePost(post.id)}
                                disabled={deletingPosts.has(post.id)}
                                className={`p-1 rounded transition-colors ${
                                  deletingPosts.has(post.id)
                                    ? 'text-gray-400 cursor-not-allowed'
                                    : 'text-red-400 hover:text-red-600 hover:bg-red-50'
                                }`}
                                title={deletingPosts.has(post.id) ? 'Deleting...' : 'Delete post'}
                              >
                                {deletingPosts.has(post.id) ? (
                                  <div className="h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                                             {/* Media Display - Image on Top */}
                       {post.media && post.media.length > 0 ? (
                         <div>
                           <div className="grid grid-cols-1 gap-0">
                             {post.media.map((mediaItem, index) => {
                               const imageUrl = mediaItem.sourceUrl || mediaItem.url || mediaItem.thumbnailUrl;

                               if (!imageUrl) {

                                 return (
                                   <div key={`${post.id}-media-${index}`} className="w-full h-48 bg-gray-200 rounded-t-lg flex items-center justify-center text-sm text-gray-500">
                                     No image available
                                   </div>
                                 );
                               }
                               
                               // Additional validation for image URL
                               if (typeof imageUrl !== 'string' || imageUrl.trim() === '') {

                                 return (
                                   <div key={`${post.id}-media-${index}`} className="w-full h-48 bg-gray-200 rounded-t-lg flex items-center justify-center text-sm text-gray-500">
                                     Invalid image URL
                                   </div>
                                 );
                               }
                               
                               return (
                                 <div key={`${post.id}-media-${index}`} className="relative group">
                                   <PostImage
                                     imageUrl={imageUrl}
                                     altText={mediaItem.altText || 'Post image'}
                                     mediaFormat={mediaItem.mediaFormat}
                                     mediaData={mediaItem}
                                   />
                                 </div>
                               );
                             })}
                           </div>
                         </div>
                       ) : (
                         <div className="mb-4 text-sm text-gray-500 text-center py-8 bg-gray-50 rounded-lg">
                           No media attached to this post
                         </div>
                       )}

                      {/* Post Content - Text Below Image. `whitespace-pre-wrap`
                          preserves Meta's newlines + emoji breaks so FB/IG
                          captions render the way they look on the source
                          platform. If a social post has no caption we show
                          a muted placeholder so it's obvious the fetch
                          worked but the caption was empty (vs. broken). */}
                      <div className="p-3">
                        <div className="text-sm text-gray-900 mb-3 whitespace-pre-wrap break-words">
                          {post.content ? (
                            expandedPosts.has(post.id) ? (
                              <div>
                                <p>{post.content}</p>
                                <button
                                  onClick={() => toggleExpanded(post.id)}
                                  className="text-primary-600 hover:text-primary-700 font-medium mt-2 text-sm"
                                >
                                  Show less
                                </button>
                              </div>
                            ) : (
                              <div>
                                <p>{truncateToFirstSentence(post.content)}</p>
                                {post.content.length > 150 && (
                                  <button
                                    onClick={() => toggleExpanded(post.id)}
                                    className="text-primary-600 hover:text-primary-700 font-medium mt-2 text-sm"
                                  >
                                    ...more
                                  </button>
                                )}
                              </div>
                            )
                          ) : (
                            <p className="italic text-gray-400">
                              {post._provider ? '(no caption)' : ''}
                            </p>
                          )}
                        </div>

                                                 {/* Post Footer with Date, Status, and CTA */}
                         <div className="flex items-center justify-between text-xs text-gray-500 pt-2 border-t border-gray-100">
                           <span className="flex items-center">
                             <Clock className="h-4 w-4 mr-1" />
                             {post.createdAt ? formatRelativeTime(post.createdAt) : 'Date not available'}
                           </span>
                           <div className="flex items-center space-x-3">
                             {post.callToAction && (
                               <a
                                 href={post.callToAction.url || '#'}
                                 target="_blank"
                                 rel="noopener noreferrer"
                                 className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded transition-colors duration-200 ${
                                   post.callToAction.url 
                                     ? 'bg-blue-100 text-blue-800 hover:bg-blue-200' 
                                     : 'bg-gray-100 text-gray-500 cursor-not-allowed'
                                 }`}
                                 onClick={!post.callToAction.url ? (e) => e.preventDefault() : undefined}
                               >
                                 {post.callToAction.actionType || 'CTA'}
                               </a>
                             )}
                             {post.status === 'published' && (
                               <span className="flex items-center">
                                 <CheckCircle className="h-4 w-4 mr-1" />
                                 Published
                               </span>
                             )}
                           </div>
                         </div>


                                             </div>
                     </div>
                   );
                   })}
                </div>
                
              </>
            ) : (
              <div className="col-span-full px-6 py-12 text-center">
                <FileText className="mx-auto h-16 w-16 text-gray-400" />
                <h3 className="mt-4 text-lg font-medium text-gray-900">No posts yet</h3>
                <p className="mt-2 text-sm text-gray-500 max-w-md mx-auto">
                  Get started by creating your first post for this location. Your posts will appear here in a beautiful grid layout.
                </p>

              </div>
            )}
          </div>
        </div>
      )}

      {drivePickerOpen && (
        <DrivePickerModal
          existingUrls={currentMediaUrls()}
          onClose={() => setDrivePickerOpen(false)}
          onPick={handleDrivePicked}
        />
      )}

    </div>
  );
};

export default Posts;
