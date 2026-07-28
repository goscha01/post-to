// Tiny localStorage-backed memory for the composer:
//   - Recently used CTA URLs
//   - Recently used CTA phone numbers
//   - Last-opened Drive folder path (per account scope)
//
// All values fail-soft: quota/serialization errors just return defaults so
// the composer keeps working even in incognito or with disabled storage.

const KEYS = {
  urls: 'post-to.cta.urls',
  phones: 'post-to.cta.phones',
  driveFolder: 'post-to.drive.lastFolderPath',
};

const CAP = 20;

const safeGet = (key, fallback) => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const safeSet = (key, value) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full / disabled — non-fatal
  }
};

export const getRecentUrls = () => {
  const v = safeGet(KEYS.urls, []);
  return Array.isArray(v) ? v : [];
};

export const rememberUrl = (url) => {
  const trimmed = (url || '').trim();
  if (!trimmed) return;
  const list = getRecentUrls().filter((u) => u !== trimmed);
  list.unshift(trimmed);
  safeSet(KEYS.urls, list.slice(0, CAP));
};

export const getRecentPhones = () => {
  const v = safeGet(KEYS.phones, []);
  return Array.isArray(v) ? v : [];
};

export const rememberPhone = (phone) => {
  const trimmed = (phone || '').trim();
  if (!trimmed) return;
  const list = getRecentPhones().filter((p) => p !== trimmed);
  list.unshift(trimmed);
  safeSet(KEYS.phones, list.slice(0, CAP));
};

// Drive folder memory is keyed by accountScope so switching accounts
// doesn't restore a folder id from a different Drive.
export const getLastDriveFolder = (scopeKey) => {
  const v = safeGet(KEYS.driveFolder, {});
  if (!v || typeof v !== 'object') return null;
  const rec = v[scopeKey || ''];
  return Array.isArray(rec) ? rec : null;
};

export const rememberDriveFolder = (scopeKey, path) => {
  const v = safeGet(KEYS.driveFolder, {});
  const map = v && typeof v === 'object' ? { ...v } : {};
  map[scopeKey || ''] = Array.isArray(path) ? path : [];
  safeSet(KEYS.driveFolder, map);
};
