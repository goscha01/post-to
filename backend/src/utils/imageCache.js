const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Use the service-role key — image_cache RLS restricts to authenticated role,
// and the backend acts on behalf of users without a per-user JWT for this op.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

/**
 * Download image from URL and convert to base64
 * @param {string} imageUrl - The URL of the image to download
 * @returns {Promise<Object>} - Object containing image data and metadata
 */
async function downloadImageFromUrl(imageUrl) {
  try {
    // Downloading image from URL
    
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000, // 10 second timeout
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || 'image/jpeg';
    
    // Convert to base64
    const base64Data = `data:${contentType};base64,${buffer.toString('base64')}`;
    
    return {
      filename: `image_${Date.now()}.${contentType.split('/')[1] || 'jpg'}`,
      size: buffer.length,
      type: contentType,
      data: base64Data,
      uploaded_at: new Date().toISOString(),
      source_url: imageUrl
    };
  } catch (error) {
    throw new Error(`Failed to download image: ${error.message}`);
  }
}

/**
 * Check if image is already cached in database
 * @param {string} imageUrl - The URL of the image to check
 * @returns {Promise<Object|null>} - Cached image data or null if not found
 */
async function getCachedImage(imageUrl) {
  try {
    const { data, error } = await supabase
      .from('image_cache')
      .select('*')
      .eq('source_url', imageUrl)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
      return null;
    }

    return data;
  } catch (error) {
    return null;
  }
}

/**
 * Store image in cache table
 * @param {Object} imageData - Image data to store
 * @returns {Promise<Object>} - Stored image data
 */
async function storeImageInCache(imageData) {
  try {
    const { data, error } = await supabase
      .from('image_cache')
      .insert({
        source_url: imageData.source_url,
        filename: imageData.filename,
        size: imageData.size,
        type: imageData.type,
        data: imageData.data,
        uploaded_at: imageData.uploaded_at
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    throw error;
  }
}

/**
 * Get or download image - checks cache first, downloads if not found
 * @param {string} imageUrl - The URL of the image
 * @returns {Promise<Object>} - Image data (from cache or newly downloaded)
 */
async function getOrDownloadImage(imageUrl) {
  try {
    // First, check if image is already cached
    // Checking cache for image
    let cachedImage = await getCachedImage(imageUrl);
    
    if (cachedImage) {
      // Using cached image
      return {
        filename: cachedImage.filename,
        size: cachedImage.size,
        type: cachedImage.type,
        data: cachedImage.data,
        uploaded_at: cachedImage.uploaded_at,
        source_url: cachedImage.source_url,
        cached: true
      };
    }

    // Image not in cache, download it
    const downloadedImage = await downloadImageFromUrl(imageUrl);
    
    // Store in cache for future use
    await storeImageInCache(downloadedImage);
    
    return {
      ...downloadedImage,
      cached: false
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Process multiple images - checks cache first, downloads if needed
 * @param {Array} imageUrls - Array of image URLs
 * @returns {Promise<Array>} - Array of processed image data
 */
async function processImages(imageUrls) {
  const results = [];
  
  for (const url of imageUrls) {
    try {
      const imageData = await getOrDownloadImage(url);
      results.push(imageData);
    } catch (error) {
      // Continue with other images even if one fails
      results.push({
        filename: `failed_${Date.now()}.jpg`,
        size: 0,
        type: 'image/jpeg',
        data: null,
        uploaded_at: new Date().toISOString(),
        source_url: url,
        cached: false,
        error: error.message
      });
    }
  }
  
  return results;
}

module.exports = {
  downloadImageFromUrl,
  getCachedImage,
  storeImageInCache,
  getOrDownloadImage,
  processImages
};
