// AES-256-GCM encrypt/decrypt with an env-var-derived key.
//
// Used to encrypt provider secrets (Apple .p8 private keys today; anything
// similar tomorrow) before writing to connected_accounts.metadata. Supabase
// encrypts at rest, but a DB dump or compromised read still yields the
// plaintext key — this adds a second layer keyed off an env var so a DB
// leak alone isn't enough to sign App Store Connect JWTs.
//
// Format returned by encrypt(): a single string
//   v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
// decrypt() rejects anything else. Bump the "v1" prefix if the algorithm
// ever changes so old payloads fail fast rather than silently mis-decode.
//
// Key: 32 bytes, provided via env var ASC_ENCRYPTION_KEY (base64-encoded).
// Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Losing this key means every stored secret is unrecoverable — treat it
// like a database credential, not a config toggle.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;              // 96-bit IV is the GCM standard.
const KEY_LEN = 32;             // 256-bit key.
const VERSION = 'v1';

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.ASC_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ASC_ENCRYPTION_KEY env var is not set — cannot encrypt/decrypt provider secrets');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_LEN) {
    throw new Error(`ASC_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (got ${buf.length}) — generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
  }
  cachedKey = buf;
  return cachedKey;
}

// Test-only reset — clears the cached key so a test can rotate env vars
// between cases. Do NOT call from production code.
function _resetKeyCache() {
  cachedKey = null;
}

function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new Error('encrypt() requires a string plaintext');
  }
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(payload) {
  if (typeof payload !== 'string' || !payload.startsWith(`${VERSION}:`)) {
    throw new Error('decrypt() got an unrecognized payload format');
  }
  const parts = payload.split(':');
  if (parts.length !== 4) {
    throw new Error('decrypt() got a malformed payload');
  }
  const [, ivB64, tagB64, encB64] = parts;
  const key = loadKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

function isEncrypted(payload) {
  return typeof payload === 'string' && payload.startsWith(`${VERSION}:`);
}

module.exports = { encrypt, decrypt, isEncrypted, _resetKeyCache };
