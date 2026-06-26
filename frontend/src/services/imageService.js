import axios from '../utils/axiosConfig';
import sessionCacheConfig from '../config/sessionCacheConfig';

class ImageService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = new Map();
    this.pendingRequests = new Map();
    this.batchQueue = [];
    this.batchTimeout = null;
    this.batchSize = 5; // Process 5 images at a time
    this.batchDelay = 100; // 100ms delay between batches
    // Use session-based TTL instead of permanent cache
    this.sessionCacheConfig = sessionCacheConfig;
  }

  // Get image with caching and batching
  async getImage(imageUrl, options = {}) {
    const { useCache = true, priority = 'normal' } = options;
    
    // Return cached image if available and not expired
    if (useCache) {
      const cachedImage = this.getCachedImage(imageUrl);
      if (cachedImage) {
        return cachedImage;
      }
    }

    // Return pending request if already in progress
    if (this.pendingRequests.has(imageUrl)) {
      return this.pendingRequests.get(imageUrl);
    }

    // Create promise for this image
    const imagePromise = this.processImage(imageUrl, priority);
    this.pendingRequests.set(imageUrl, imagePromise);

    try {
      const result = await imagePromise;
      if (useCache && result.success) {
        this.setCachedImage(imageUrl, result);
      }
      return result;
    } finally {
      this.pendingRequests.delete(imageUrl);
    }
  }

  // Get cached image or return null if expired
  getCachedImage(imageUrl) {
    const expiry = this.cacheExpiry.get(imageUrl);
    if (!expiry || Date.now() > expiry) {
      this.cache.delete(imageUrl);
      this.cacheExpiry.delete(imageUrl);
      return null;
    }
    return this.cache.get(imageUrl);
  }

  // Set cached image with session-based expiry
  setCachedImage(imageUrl, result) {
    // Check if we should use cache based on session
    if (!this.sessionCacheConfig.shouldUseCache('userProfile')) {
      return;
    }

    // Get session-based TTL for user profile images
    const ttl = this.sessionCacheConfig.getTTL('userProfile');
    if (ttl <= 0) {
      return;
    }

    this.cache.set(imageUrl, result);
    this.cacheExpiry.set(imageUrl, Date.now() + ttl);
    
  }

  // Process single image
  async processImage(imageUrl, priority = 'normal') {
    try {
      // Check if it's a Google Photos URL that needs proxying
      if (imageUrl && imageUrl.includes('lh3.googleusercontent.com')) {
        
        const response = await axios.get(`http://localhost:3001/api/gmb/proxy-image?url=${encodeURIComponent(imageUrl)}`);
        
        if (response.data.success && response.data.dataUrl) {
          return {
            success: true,
            dataUrl: response.data.dataUrl,
            contentType: response.data.contentType,
            size: response.data.size
          };
        } else {
          throw new Error(`Backend processing failed: ${response.data.error || 'Unknown error'}`);
        }
      } else {
        // For non-Google URLs, return directly
        return {
          success: true,
          dataUrl: imageUrl,
          contentType: 'image/jpeg',
          size: 0
        };
      }
    } catch (error) {
      
      return {
        success: false,
        error: error.message,
        details: error.response?.data || null
      };
    }
  }

  // Batch process multiple images
  async getImagesBatch(imageUrls, options = {}) {
    const { useCache = true, priority = 'normal' } = options;
    
    // Filter out cached images
    const uncachedUrls = useCache 
      ? imageUrls.filter(url => !this.getCachedImage(url))
      : imageUrls;

    if (uncachedUrls.length === 0) {
      // All images are cached
      return imageUrls.map(url => this.getCachedImage(url));
    }

    // Process in batches to avoid rate limiting
    const results = [];
    for (let i = 0; i < uncachedUrls.length; i += this.batchSize) {
      const batch = uncachedUrls.slice(i, i + this.batchSize);
      const batchPromises = batch.map(url => this.getImage(url, { useCache, priority }));
      
      try {
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // Add delay between batches to respect rate limits
        if (i + this.batchSize < uncachedUrls.length) {
          await new Promise(resolve => setTimeout(resolve, this.batchDelay));
        }
      } catch (error) {
        // Add error results for failed batch
        results.push(...batch.map(() => ({ success: false, error: error.message })));
      }
    }

    // Combine with cached results
    const allResults = imageUrls.map(url => {
      const cachedImage = this.getCachedImage(url);
      if (cachedImage) {
        return cachedImage;
      }
      const index = uncachedUrls.indexOf(url);
      return results[index] || { success: false, error: 'Not processed' };
    });

    return allResults;
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
    this.cacheExpiry.clear();
  }

  // Get cache stats
  getCacheStats() {
    return {
      size: this.cache.size,
      pendingRequests: this.pendingRequests.size
    };
  }
}

// Export singleton instance
export default new ImageService();
