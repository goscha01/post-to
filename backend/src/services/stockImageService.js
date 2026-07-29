// Stock photo search via Pexels. Free tier: 200 req/hour, no attribution
// required (though we surface photographer name for good citizenship).
//
// Two operations:
//   1. searchPexels(query) → returns 9 candidate images (thumbnail + full
//      URLs + photographer). Called from the "Suggest images" button.
//   2. downloadImage(url) → fetches image bytes for server-side upload to
//      the customer's S3 bucket (so the hero image lives at THEIR domain,
//      not hotlinked from Pexels).

const axios = require('axios');
const logger = require('../utils/logger');

const PEXELS_API = 'https://api.pexels.com/v1';
// How many candidates to show in the UI grid. 9 fits a 3×3 layout without
// overwhelming; enough variation to find something on-topic.
const CANDIDATES = 9;

async function searchPexels(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    const err = new Error('PEXELS_API_KEY not configured on this deployment');
    err.status = 500;
    throw err;
  }
  const q = String(query || '').trim();
  if (!q) {
    const err = new Error('Search query required');
    err.status = 400;
    throw err;
  }

  const res = await axios.get(`${PEXELS_API}/search`, {
    params: {
      query: q,
      per_page: CANDIDATES,
      orientation: 'landscape', // hero images are wide by convention
      size: 'medium',           // >= 1200×768 — enough for hero rendering
    },
    headers: { Authorization: key, 'User-Agent': 'post-to/1.0' },
    timeout: 8000,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    logger.warn('stock.pexels.search_failed', { query: q, status: res.status, error: res.data?.error });
    const err = new Error(res.data?.error || `Pexels API returned ${res.status}`);
    err.status = res.status >= 400 && res.status < 500 ? res.status : 502;
    throw err;
  }

  // Normalize into a shape the frontend can consume without knowing about
  // Pexels' quirks. Frontend picks one → sends its `full_url` back to us
  // for the actual download+upload.
  const photos = (res.data.photos || []).map(p => ({
    id: `pexels:${p.id}`,
    // Landscape hero uses src.large (≈1500×1000). src.original is 4000+px
    // — too big for our purposes; site build would resize anyway.
    full_url: p.src.large2x || p.src.large || p.src.original,
    thumb_url: p.src.medium || p.src.small,
    width: p.width,
    height: p.height,
    alt: p.alt || q,
    photographer: p.photographer,
    photographer_url: p.photographer_url,
    source: 'pexels',
    source_page: p.url,
  }));

  logger.info('stock.pexels.search_ok', { query: q, count: photos.length });
  return photos;
}

// Fetch a remote image and return its Buffer + inferred content-type. Used
// to pull the chosen image from Pexels into our upload pipeline. Keeps the
// image on the customer's own S3 (no hotlinking; survives Pexels URL rot).
async function downloadImage(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: 20 * 1024 * 1024, // 20 MB safety cap
    headers: { 'User-Agent': 'post-to/1.0' },
    validateStatus: s => s >= 200 && s < 400,
  });
  const contentType = res.headers['content-type'] || 'image/jpeg';
  return { buffer: Buffer.from(res.data), contentType, bytes: res.data.byteLength };
}

module.exports = { searchPexels, downloadImage };
