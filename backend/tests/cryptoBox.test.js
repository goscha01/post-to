// Tests for utils/cryptoBox — the AES-256-GCM helper used to encrypt
// Apple App Store Connect .p8 keys (and any future provider secret) at
// rest. Covers the round-trip, tamper detection, wrong-key rejection,
// bad-config errors, and format validation.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// A stable test key so encrypt/decrypt round-trip works within a run.
const TEST_KEY = crypto.randomBytes(32).toString('base64');
process.env.ASC_ENCRYPTION_KEY = TEST_KEY;

const box = require('../src/utils/cryptoBox');
box._resetKeyCache();

test('encrypt then decrypt returns the original plaintext', () => {
  const secret = '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----';
  const ct = box.encrypt(secret);
  assert.ok(box.isEncrypted(ct));
  assert.notEqual(ct, secret);
  assert.equal(box.decrypt(ct), secret);
});

test('encryption is non-deterministic (fresh IV each call)', () => {
  const ct1 = box.encrypt('hello');
  const ct2 = box.encrypt('hello');
  assert.notEqual(ct1, ct2);
  assert.equal(box.decrypt(ct1), 'hello');
  assert.equal(box.decrypt(ct2), 'hello');
});

test('decrypt rejects a payload with the wrong version prefix', () => {
  assert.throws(() => box.decrypt('v2:aaa:bbb:ccc'), /unrecognized/);
  assert.throws(() => box.decrypt('raw ciphertext'), /unrecognized/);
});

test('decrypt rejects a malformed payload (too few segments)', () => {
  assert.throws(() => box.decrypt('v1:notenough:parts'), /malformed/);
});

test('decrypt fails on tampered ciphertext (GCM auth tag rejects it)', () => {
  const ct = box.encrypt('sensitive');
  const parts = ct.split(':');
  // Flip a bit in the last byte of the ciphertext.
  const encBuf = Buffer.from(parts[3], 'base64');
  encBuf[encBuf.length - 1] ^= 0x01;
  parts[3] = encBuf.toString('base64');
  const tampered = parts.join(':');
  assert.throws(() => box.decrypt(tampered));
});

test('decrypt fails on tampered auth tag', () => {
  const ct = box.encrypt('sensitive');
  const parts = ct.split(':');
  const tagBuf = Buffer.from(parts[2], 'base64');
  tagBuf[0] ^= 0x01;
  parts[2] = tagBuf.toString('base64');
  const tampered = parts.join(':');
  assert.throws(() => box.decrypt(tampered));
});

test('decrypt fails when the key rotates', () => {
  const ct = box.encrypt('rotate-me');
  // Rotate the env var to a fresh 32-byte key. Same length, different bytes
  // → old ciphertext should fail auth.
  const oldKey = process.env.ASC_ENCRYPTION_KEY;
  process.env.ASC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  box._resetKeyCache();
  try {
    assert.throws(() => box.decrypt(ct));
  } finally {
    process.env.ASC_ENCRYPTION_KEY = oldKey;
    box._resetKeyCache();
  }
});

test('loadKey throws a clear error when env var is missing', () => {
  const saved = process.env.ASC_ENCRYPTION_KEY;
  delete process.env.ASC_ENCRYPTION_KEY;
  box._resetKeyCache();
  try {
    assert.throws(() => box.encrypt('x'), /ASC_ENCRYPTION_KEY env var is not set/);
  } finally {
    process.env.ASC_ENCRYPTION_KEY = saved;
    box._resetKeyCache();
  }
});

test('loadKey throws when key is wrong length', () => {
  const saved = process.env.ASC_ENCRYPTION_KEY;
  process.env.ASC_ENCRYPTION_KEY = Buffer.from('short').toString('base64');
  box._resetKeyCache();
  try {
    assert.throws(() => box.encrypt('x'), /must decode to 32 bytes/);
  } finally {
    process.env.ASC_ENCRYPTION_KEY = saved;
    box._resetKeyCache();
  }
});

test('encrypt rejects non-string input', () => {
  assert.throws(() => box.encrypt(null), /requires a string/);
  assert.throws(() => box.encrypt(42), /requires a string/);
  assert.throws(() => box.encrypt({}), /requires a string/);
});

test('round-trips multi-line PEM strings without corruption', () => {
  const pem = [
    '-----BEGIN PRIVATE KEY-----',
    'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg9Gp0KIhZ',
    'zaWMbLlpUTOOTUxVeYb/oI/9tuI+8oplKvKgCgYIKoZIzj0DAQehRANC',
    'AAQ0RUnQfcedDIiugmYlYUMsFLPmKm5YCiClgUXMzRkGZH8+i+2GS9V/',
    'xrq3Yku0jvbBdcowlBAFRQANFxOMYpTB',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  assert.equal(box.decrypt(box.encrypt(pem)), pem);
});

test('isEncrypted returns false for garbage / plaintext', () => {
  assert.equal(box.isEncrypted('not encrypted'), false);
  assert.equal(box.isEncrypted(''), false);
  assert.equal(box.isEncrypted(null), false);
  assert.equal(box.isEncrypted(box.encrypt('yes')), true);
});
