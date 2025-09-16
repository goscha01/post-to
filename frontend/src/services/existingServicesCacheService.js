class ExistingServicesCacheService {
  constructor() {
    this.cacheTimeout = 2 * 60 * 1000; // 2 minutes (shorter than available services since these change more frequently)
    this.cachePrefix = 'existing_services_cache_';
    this.expiryPrefix = 'existing_services_expiry_';
  }

  // Get cached data or return null if expired
  getCachedData(locationId) {
    console.log('🔍 existingServicesCacheService.getCachedData called for locationId:', locationId);
    
    try {
      const cacheKey = this.cachePrefix + locationId;
      const expiryKey = this.expiryPrefix + locationId;
      
      const expiry = localStorage.getItem(expiryKey);
      console.log('🔍 Cache expiry for location', locationId, ':', expiry ? new Date(parseInt(expiry)) : 'none');
      console.log('🔍 Current time:', new Date());
      
      if (!expiry || Date.now() > parseInt(expiry)) {
        console.log('🔍 Cache expired or not found for location', locationId);
        localStorage.removeItem(cacheKey);
        localStorage.removeItem(expiryKey);
        return null;
      }
      
      const cachedData = localStorage.getItem(cacheKey);
      if (cachedData) {
        const parsedData = JSON.parse(cachedData);
        console.log('🔍 Found cached existing services for location', locationId, ':', parsedData ? `${parsedData.length} items` : 'null');
        return parsedData;
      }
      
      console.log('🔍 No cached existing services found for location', locationId);
      return null;
    } catch (error) {
      console.error('Error reading existing services from cache:', error);
      return null;
    }
  }

  // Set cached data with expiry
  setCachedData(locationId, data) {
    console.log('💾 existingServicesCacheService.setCachedData called for locationId:', locationId, 'with', data ? `${data.length} items` : 'null data');
    
    try {
      const cacheKey = this.cachePrefix + locationId;
      const expiryKey = this.expiryPrefix + locationId;
      
      localStorage.setItem(cacheKey, JSON.stringify(data));
      localStorage.setItem(expiryKey, (Date.now() + this.cacheTimeout).toString());
      console.log('💾 Existing services cache set for location', locationId, 'expires at:', new Date(Date.now() + this.cacheTimeout));
    } catch (error) {
      console.error('Error writing existing services to cache:', error);
    }
  }

  // Clear specific cache entry
  clearCache(locationId) {
    const cacheKey = this.cachePrefix + locationId;
    const expiryKey = this.expiryPrefix + locationId;
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

export default new ExistingServicesCacheService();
