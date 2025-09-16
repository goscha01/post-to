import imageService from './imageService';

class ServicesMediaService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
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

  // Set cached image with expiry
  setCachedImage(url, dataUrl) {
    this.cache.set(url, dataUrl);
    this.cacheExpiry.set(url, Date.now() + this.cacheTimeout);
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
