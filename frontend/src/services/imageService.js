import axios from '../utils/axiosConfig';

class ImageService {
  constructor() {
    this.cache = new Map();
    this.pendingRequests = new Map();
    this.batchQueue = [];
    this.batchTimeout = null;
    this.batchSize = 5; // Process 5 images at a time
    this.batchDelay = 100; // 100ms delay between batches
  }

  // Get image with caching and batching
  async getImage(imageUrl, options = {}) {
    const { useCache = true, priority = 'normal' } = options;
    
    // Return cached image if available
    if (useCache && this.cache.has(imageUrl)) {
      return this.cache.get(imageUrl);
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
      if (useCache) {
        this.cache.set(imageUrl, result);
      }
      return result;
    } finally {
      this.pendingRequests.delete(imageUrl);
    }
  }

  // Process single image
  async processImage(imageUrl, priority = 'normal') {
    try {
      // Check if it's a Google Photos URL that needs proxying
      if (imageUrl && imageUrl.includes('lh3.googleusercontent.com')) {
        console.log(`🖼️ Processing Google Photos URL: ${imageUrl.substring(0, 50)}...`);
        
        const response = await axios.get(`http://localhost:3001/api/gmb/proxy-image?url=${encodeURIComponent(imageUrl)}`);
        
        if (response.data.success && response.data.dataUrl) {
          console.log(`✅ Successfully processed image: ${response.data.size} bytes`);
          return {
            success: true,
            dataUrl: response.data.dataUrl,
            contentType: response.data.contentType,
            size: response.data.size
          };
        } else {
          console.error('❌ Backend returned unsuccessful response:', response.data);
          throw new Error(`Backend processing failed: ${response.data.error || 'Unknown error'}`);
        }
      } else {
        // For non-Google URLs, return directly
        console.log(`🖼️ Processing non-Google URL: ${imageUrl.substring(0, 50)}...`);
        return {
          success: true,
          dataUrl: imageUrl,
          contentType: 'image/jpeg',
          size: 0
        };
      }
    } catch (error) {
      console.error('❌ Error processing image:', error);
      console.error('❌ Image URL:', imageUrl);
      console.error('❌ Error details:', {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      
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
      ? imageUrls.filter(url => !this.cache.has(url))
      : imageUrls;

    if (uncachedUrls.length === 0) {
      // All images are cached
      return imageUrls.map(url => this.cache.get(url));
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
        console.error('Batch processing error:', error);
        // Add error results for failed batch
        results.push(...batch.map(() => ({ success: false, error: error.message })));
      }
    }

    // Combine with cached results
    const allResults = imageUrls.map(url => {
      if (this.cache.has(url)) {
        return this.cache.get(url);
      }
      const index = uncachedUrls.indexOf(url);
      return results[index] || { success: false, error: 'Not processed' };
    });

    return allResults;
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
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
