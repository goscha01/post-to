// Google Drive image browser.
//
// GET /api/drive/images?q=&pageSize=&folderId=&nextPageToken=
//   Lists image files from every connected business OAuth token, deduped by
//   Drive file id. Each file is annotated with `used: boolean` and, if used,
//   the id of the first social_media_posts row whose media_urls or
//   media_data[].filename matches — matched on filename only, per product ask.
//
// Requires the drive.readonly scope on the business OAuth grant. Existing
// users granted access before this scope was added get 403 with
// needsReauth=true so the frontend can prompt a reconnect.

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const { getAllBusinessTokens, tryWithEachBusinessToken } = require('../utils/businessTokens');
const logger = require('../utils/logger');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);
router.use(requireBusinessAuth);

function driveClient(accessToken) {
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth: oauth2 });
}

// Detects the "insufficient scope" case so the frontend can prompt a
// reconnect instead of a generic error.
function isMissingScope(err) {
  const status = err?.response?.status || err?.code;
  const msg = (err?.response?.data?.error?.message || err?.message || '').toLowerCase();
  return (
    status === 403 &&
    (msg.includes('insufficient') || msg.includes('scope') || msg.includes('permission'))
  );
}

// Pull every filename we've ever referenced from social_media_posts so we
// can flag Drive files that are already in use. Filename comparison is
// intentionally loose — Drive names don't always match URL segments — so
// we normalize both sides.
async function loadUsedFilenames(userId) {
  const { data, error } = await supabase
    .from('social_media_posts')
    .select('id, published_at, media_urls, media_data')
    .eq('user_id', userId)
    .order('published_at', { ascending: false })
    .limit(1000);
  if (error) {
    logger.warn('drive.used_filenames_query_error', { user_id: userId, error: error.message });
    return new Map();
  }
  const map = new Map(); // normalizedName -> { postId, publishedAt }
  const normalize = (s) => (s || '').toString().trim().toLowerCase();
  for (const row of data || []) {
    const record = { postId: row.id, publishedAt: row.published_at };
    // media_data[].filename (from uploaded files)
    if (Array.isArray(row.media_data)) {
      for (const m of row.media_data) {
        const fn = normalize(m?.filename);
        if (fn && !map.has(fn)) map.set(fn, record);
      }
    }
    // media_urls[]: URLs — take the last path segment.
    if (Array.isArray(row.media_urls)) {
      for (const u of row.media_urls) {
        if (!u || typeof u !== 'string') continue;
        try {
          const path = new URL(u).pathname;
          const last = path.split('/').filter(Boolean).pop();
          const decoded = last ? decodeURIComponent(last) : '';
          const fn = normalize(decoded);
          if (fn && !map.has(fn)) map.set(fn, record);
        } catch {
          // Not a valid URL — treat the whole string as a filename
          const fn = normalize(u.split('/').pop());
          if (fn && !map.has(fn)) map.set(fn, record);
        }
      }
    }
  }
  return map;
}

router.get('/images', async (req, res) => {
  const userId = req.user?.userId;
  const {
    q = '',
    pageSize = '50',
    folderId = '',
    // 'images' = image files only (default; backwards compatible)
    // 'folders' = subfolders only
    // 'both' = folders + images (what the picker uses to browse a folder)
    type = 'images',
    // Optional: scope the fanout to a single connected Google account.
    // Values: googleId (numeric string) or email address. When absent we
    // fan out across every business_profiles token (union view).
    googleId = '',
    profileEmail = '',
  } = req.query;

  const pageSizeNum = Math.max(1, Math.min(200, parseInt(pageSize, 10) || 50));

  // Build the Drive q filter. Always scope to non-trashed items. Trashed
  // defaults to inclusive in Drive's API which is almost never what people
  // actually want.
  const filters = ['trashed = false'];
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  if (type === 'folders') {
    filters.push(`mimeType = '${FOLDER_MIME}'`);
  } else if (type === 'both') {
    filters.push(`(mimeType contains 'image/' or mimeType = '${FOLDER_MIME}')`);
  } else {
    filters.push('mimeType contains "image/"');
  }
  if (folderId) {
    filters.push(`'${folderId.replace(/'/g, "\\'")}' in parents`);
  } else if (type === 'both' || type === 'folders') {
    // At the root show only items directly under "My Drive". Without this,
    // the API returns every file in the account, defeating the point of
    // folder navigation.
    filters.push(`'root' in parents`);
  }
  if (q && q.trim()) {
    const safe = q.trim().replace(/'/g, "\\'");
    filters.push(`name contains '${safe}'`);
  }
  const qString = filters.join(' and ');

  try {
    // Multi-profile fanout: hit Drive with every stored business token,
    // dedupe by file id. When googleId/profileEmail is passed the fanout
    // narrows to a single connected Google account — the composer sends
    // this after the user picks a business profile so the picker only
    // surfaces folders/files from THAT account's Drive.
    const tokens = await getAllBusinessTokens(userId);
    let candidates = tokens.length > 0
      ? tokens
      : (req.businessToken ? [{ access_token: req.businessToken, email: null }] : []);

    if (googleId || profileEmail) {
      const before = candidates.length;
      candidates = candidates.filter((t) =>
        (googleId && t.google_id === googleId) ||
        (profileEmail && (t.email || '').toLowerCase() === profileEmail.toLowerCase())
      );
      logger.info('drive.images.scoped', {
        user_id: userId,
        requested_google_id: googleId || null,
        requested_email: profileEmail || null,
        matched_tokens: candidates.length,
        total_tokens: before,
      });
    }

    if (candidates.length === 0) {
      return res.status(400).json({
        success: false,
        error: googleId || profileEmail
          ? 'No connected Google account matches that filter — pick a different profile or reconnect.'
          : 'No business OAuth tokens for user',
      });
    }

    let missingScope = false;
    const seen = new Map(); // fileId -> normalized item
    const perProfile = [];

    await Promise.all(candidates.map(async (t, idx) => {
      try {
        const drive = driveClient(t.access_token);
        const resp = await drive.files.list({
          q: qString,
          pageSize: pageSizeNum,
          orderBy: 'modifiedTime desc',
          fields: 'files(id,name,mimeType,thumbnailLink,webViewLink,webContentLink,iconLink,size,modifiedTime,imageMediaMetadata,parents)',
          spaces: 'drive',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
        const files = resp.data.files || [];
        for (const f of files) {
          if (!f.id || seen.has(f.id)) continue;
          seen.set(f.id, f);
        }
        perProfile.push({ profile_email: t.email || null, count: files.length });
      } catch (err) {
        if (isMissingScope(err)) missingScope = true;
        perProfile.push({
          profile_email: t.email || null,
          error: err?.message,
          status: err?.response?.status || err?.code || null,
        });
      }
    }));

    if (seen.size === 0 && missingScope) {
      logger.warn('drive.images.needs_reauth', { user_id: userId, per_profile: perProfile });
      return res.status(403).json({
        success: false,
        error: 'Google Drive access not granted. Reconnect the business profile to enable it.',
        code: 'DRIVE_NEEDS_REAUTH',
        needsReauth: true,
      });
    }

    const usedMap = await loadUsedFilenames(userId);
    const normalize = (s) => (s || '').toString().trim().toLowerCase();

    const items = Array.from(seen.values()).map((f) => {
      const isFolder = f.mimeType === FOLDER_MIME;
      const usedRec = isFolder ? null : usedMap.get(normalize(f.name));
      return {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        isFolder,
        thumbnailLink: f.thumbnailLink || null,
        webViewLink: f.webViewLink || null,
        webContentLink: f.webContentLink || null,
        iconLink: f.iconLink || null,
        size: f.size ? Number(f.size) : null,
        modifiedTime: f.modifiedTime || null,
        width: f.imageMediaMetadata?.width || null,
        height: f.imageMediaMetadata?.height || null,
        used: !!usedRec,
        usedInPostId: usedRec?.postId || null,
        usedAt: usedRec?.publishedAt || null,
      };
    });

    // Sort: folders first, then unused images, then by modifiedTime desc.
    items.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      if (a.used !== b.used) return a.used ? 1 : -1;
      return String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || ''));
    });

    logger.info('drive.images.response', {
      user_id: userId,
      count: items.length,
      per_profile: perProfile,
      q,
      folder_id: folderId || null,
    });

    res.json({
      success: true,
      items,
      count: items.length,
      profileCount: candidates.length,
      // Every connected Google account, regardless of the current filter,
      // so the picker can render an account-switcher dropdown.
      availableAccounts: tokens.map((t) => ({
        googleId: t.google_id || null,
        email: t.email || null,
      })),
      activeFilter: googleId || profileEmail ? { googleId: googleId || null, email: profileEmail || null } : null,
    });
  } catch (err) {
    logger.error('drive.images.unhandled', {
      user_id: userId,
      error: err?.message,
      stack: err?.stack?.slice(0, 1500),
    });
    res.status(500).json({ success: false, error: 'Failed to list Drive images', details: err.message });
  }
});

// Extracts a Drive fileId from any of the URL shapes we generate or Google
// itself hands back. Returns null when the URL isn't a Drive URL.
function driveFileIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // uc?export=view&id=X  |  uc?id=X
  let m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // /file/d/X/view
  m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // /open?id=X (also caught by first branch)
  // drive.google.com/uc/... path form
  m = url.match(/drive\.google\.com\/[a-z]+\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return null;
}

// Fetch a Drive file's raw bytes using any of the user's connected OAuth
// tokens. Used by /proxy (for browser preview) and by aiContentService's
// vision path (converts to base64 without requiring public sharing).
async function fetchDriveFileBytes({ userId, fileId, fallbackToken }) {
  return tryWithEachBusinessToken(userId, fallbackToken, async (accessToken) => {
    const resp = await axios.get(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        responseType: 'arraybuffer',
        maxContentLength: 25 * 1024 * 1024,
        maxBodyLength: 25 * 1024 * 1024,
        timeout: 30_000,
      }
    );
    return resp;
  });
}

// Browser preview proxy. Streams the Drive file bytes so the composer can
// render a Drive image in an <img> tag without the user first setting the
// file to "Anyone with link" on Drive.
router.get('/proxy/:fileId', async (req, res) => {
  const userId = req.user?.userId;
  const { fileId } = req.params;
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(fileId)) {
    return res.status(400).json({ success: false, error: 'Invalid file id' });
  }
  try {
    const attempt = await fetchDriveFileBytes({ userId, fileId, fallbackToken: req.businessToken });
    if (!attempt.ok) {
      logger.warn('drive.proxy.all_tokens_failed', {
        user_id: userId,
        file_id: fileId,
        tried: attempt.tried,
        error: attempt.error?.message,
      });
      return res.status(404).json({ success: false, error: 'File not found or access denied' });
    }
    const ctype = attempt.result.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', ctype);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(attempt.result.data));
  } catch (err) {
    logger.error('drive.proxy.unhandled', {
      user_id: userId,
      file_id: fileId,
      error: err?.message,
    });
    res.status(500).json({ success: false, error: 'Failed to proxy file' });
  }
});

// Attach helpers as router properties so /api/ai can import and reuse them
// without a circular-import shuffle. Router is a function; adding props to
// a function is well-defined JS and Express doesn't touch these names.
router.driveFileIdFromUrl = driveFileIdFromUrl;
router.fetchDriveFileBytes = fetchDriveFileBytes;

module.exports = router;
