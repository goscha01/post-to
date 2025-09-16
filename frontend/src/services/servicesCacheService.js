class ServicesCacheService {
  constructor() {
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    this.cachePrefix = 'services_cache_';
    this.expiryPrefix = 'services_expiry_';
  }

  // Get cached data or return null if expired
  getCachedData(key) {
    console.log('🔍 servicesCacheService.getCachedData called for key:', key);
    
    try {
      const cacheKey = this.cachePrefix + key;
      const expiryKey = this.expiryPrefix + key;
      
      const expiry = localStorage.getItem(expiryKey);
      console.log('🔍 Cache expiry for', key, ':', expiry ? new Date(parseInt(expiry)) : 'none');
      console.log('🔍 Current time:', new Date());
      
      if (!expiry || Date.now() > parseInt(expiry)) {
        console.log('🔍 Cache expired or not found for', key);
        localStorage.removeItem(cacheKey);
        localStorage.removeItem(expiryKey);
        return null;
      }
      
      const cachedData = localStorage.getItem(cacheKey);
      if (cachedData) {
        const parsedData = JSON.parse(cachedData);
        console.log('🔍 Found cached data for', key, ':', parsedData ? `${parsedData.length} items` : 'null');
        return parsedData;
      }
      
      console.log('🔍 No cached data found for', key);
      return null;
    } catch (error) {
      console.error('Error reading from cache:', error);
      return null;
    }
  }

  // Set cached data with expiry
  setCachedData(key, data) {
    console.log('💾 servicesCacheService.setCachedData called for key:', key, 'with', data ? `${data.length} items` : 'null data');
    
    try {
      const cacheKey = this.cachePrefix + key;
      const expiryKey = this.expiryPrefix + key;
      
      localStorage.setItem(cacheKey, JSON.stringify(data));
      localStorage.setItem(expiryKey, (Date.now() + this.cacheTimeout).toString());
      console.log('💾 Cache set for', key, 'expires at:', new Date(Date.now() + this.cacheTimeout));
    } catch (error) {
      console.error('Error writing to cache:', error);
    }
  }

  // Clear specific cache entry
  clearCache(key) {
    const cacheKey = this.cachePrefix + key;
    const expiryKey = this.expiryPrefix + key;
    localStorage.removeItem(cacheKey);
    localStorage.removeItem(expiryKey);
  }

  // Clear all cache
  clearAllCache() {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith(this.cachePrefix) || key.startsWith(this.expiryPrefix)) {
        localStorage.removeItem(key);
      }
    });
  }

  // Get cache stats
  getCacheStats() {
    const keys = Object.keys(localStorage);
    const cacheKeys = keys.filter(key => key.startsWith(this.cachePrefix));
    return {
      cacheSize: cacheKeys.length,
      cacheKeys: cacheKeys.map(key => key.replace(this.cachePrefix, ''))
    };
  }
}

export default new ServicesCacheService();
