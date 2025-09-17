import imageService from './imageService';
import sessionCacheConfig from '../config/sessionCacheConfig';

class ServicesMediaService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = new Map();
    // Use session-based TTL instead of fixed timeout
    this.sessionCacheConfig = sessionCacheConfig;
  }

  // Get cached image or fetch if expired
  getCachedImage(url) {
    const expiry = this.cacheExpiry.get(url);
    if (!expiry || Date.now() > expiry) {
      this.cache.delete(url);
      this.cacheExpiry.delete(url);
      return null;
    }
    return this.cache.get(url);
  }

  // Set cached image with session-based expiry
  setCachedImage(url, dataUrl) {
    // Check if we should use cache based on session
    if (!this.sessionCacheConfig.shouldUseCache('services')) {
      console.log(`🚫 Skipping cache for service image - session expired or cache disabled`);
      return;
    }

    // Get session-based TTL
    const ttl = this.sessionCacheConfig.getTTL('services');
    if (ttl <= 0) {
      console.log(`🚫 Skipping cache for service image - TTL is 0`);
      return;
    }

    this.cache.set(url, dataUrl);
    this.cacheExpiry.set(url, Date.now() + ttl);
    
    console.log(`💾 Cached service image with session-based TTL: ${ttl / 1000 / 60} minutes`);
  }

  // Process media for services (if any images are needed)
  async getMediaForServices(services) {
    if (!services || services.length === 0) return services;

    // For now, services don't typically have images, but this structure
    // allows for future expansion if service images are added
    return services;
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
    this.cacheExpiry.clear();
  }

  // Get cache stats
  getCacheStats() {
    return {
      cacheSize: this.cache.size,
      cacheKeys: Array.from(this.cache.keys())
    };
  }
}

export default new ServicesMediaService();
