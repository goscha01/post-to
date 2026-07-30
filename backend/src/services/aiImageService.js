// AI image generation for automation runs.
//
// Two responsibilities:
//   1. Call OpenAI Images (`gpt-image-1`) with a caption-derived prompt.
//   2. Upload the resulting PNG bytes into a PUBLIC Supabase Storage bucket
//      so Meta / GMB can fetch the image directly.
//
// The bucket `automation-images` is created by supabase/automations.sql.
// Objects live under `<user_id>/<uuid>.png` so a leaked path only ever
// exposes one image at a time, and it's straightforward to purge one user's
// images without touching anyone else's.

const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const BUCKET = process.env.AUTOMATION_IMAGE_BUCKET || 'automation-images';
const IMAGE_MODEL = process.env.AI_IMAGE_MODEL || 'gpt-image-1';
// gpt-image-1 supports 1024x1024, 1024x1536, 1536x1024. Default to landscape —
// works for FB feed + GMB (which crops), acceptable for IG (which crops to
// 4:5 or 1:1; landscape crops less aggressively than portrait).
const IMAGE_SIZE = process.env.AI_IMAGE_SIZE || '1024x1024';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Build a short, concrete image prompt from a caption or blog title. The
// LLM caption is often too abstract to make a good image ("Deep clean your
// Tampa kitchen this spring") — we take the concrete subject nouns and
// strip city/brand names that would trip content policies.
function defaultImagePrompt({ caption, businessType, style }) {
  const subject = (caption || '').slice(0, 200).replace(/[#@]/g, '').trim();
  const s = style || 'bright, natural light, photorealistic, no text, no logos, no watermarks, magazine editorial';
  return `Editorial photograph illustrating: ${subject}. Business context: ${businessType || 'local service business'}. Style: ${s}.`;
}

async function generateImageBytes(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const body = {
    model: IMAGE_MODEL,
    prompt,
    // gpt-image-1 returns b64_json by default (no `response_format` field needed).
    size: IMAGE_SIZE,
    n: 1,
  };

  const resp = await axios.post(OPENAI_IMAGES_URL, body, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 90_000,
  });

  const b64 = resp.data?.data?.[0]?.b64_json;
  const url = resp.data?.data?.[0]?.url;
  if (b64) return Buffer.from(b64, 'base64');
  if (url) {
    // DALL-E-2 / DALL-E-3 (fallback path) returns a temporary URL. Download
    // the bytes so we upload them to our own bucket immediately, before the
    // OpenAI-hosted URL expires (typically 1 hour).
    const imgResp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000 });
    return Buffer.from(imgResp.data);
  }
  throw new Error('OpenAI image response missing both b64_json and url');
}

async function uploadToBucket({ userId, buffer, ext = 'png', contentType = 'image/png' }) {
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType,
      upsert: false,
      cacheControl: '31536000',
    });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { path, publicUrl: pub?.publicUrl };
}

// Generate an image and return a public HTTPS URL for it. Callers pass a
// caption (used to derive the prompt) or a fully-formed prompt template.
async function generateAndHost({ userId, caption, businessType, promptTemplate, style }) {
  const prompt = promptTemplate
    ? promptTemplate.replace('{caption}', caption || '').replace('{businessType}', businessType || '')
    : defaultImagePrompt({ caption, businessType, style });

  const buffer = await generateImageBytes(prompt);
  const uploaded = await uploadToBucket({ userId, buffer });
  logger.info('ai_image.generated', {
    user_id: userId,
    prompt_prefix: prompt.slice(0, 80),
    bytes: buffer.length,
    path: uploaded.path,
  });
  return { url: uploaded.publicUrl, path: uploaded.path, prompt, bytes: buffer.length };
}

module.exports = {
  generateAndHost,
  generateImageBytes,
  uploadToBucket,
  defaultImagePrompt,
  BUCKET,
};
