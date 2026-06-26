const cacheService = {
  memoryCache: new Map(),
  cacheExpiry: new Map(),

  setMemoryCache(key, data, ttl = 300000) {
    this.memoryCache.set(key, data);
    this.cacheExpiry.set(key, Date.now() + ttl);
  },

  getMemoryCache(key) {
    const expiry = this.cacheExpiry.get(key);
    if (!expiry || Date.now() > expiry) {
      this.memoryCache.delete(key);
      this.cacheExpiry.delete(key);
      return null;
    }
    return this.memoryCache.get(key);
  },

  clearAllMemoryCache() {
    this.memoryCache.clear();
    this.cacheExpiry.clear();
  },

  getCacheStats() {
    return {
      totalEntries: this.memoryCache.size,
      activeEntries: this.memoryCache.size,
      memoryUsage: process.memoryUsage()
    };
  },

  cleanExpiredCache() {
    const now = Date.now();
    const expiredKeys = [];
    for (const [key, expiry] of this.cacheExpiry.entries()) {
      if (now > expiry) {
        expiredKeys.push(key);
      }
    }
    expiredKeys.forEach(key => {
      this.memoryCache.delete(key);
      this.cacheExpiry.delete(key);
    });
    return expiredKeys.length;
  },

  invalidateCache(endpoint, userId) {
    const pattern = new RegExp(`^${userId}:${endpoint.replace(/\*/g, '.*')}:`);
    const keysToDelete = [];
    for (const key of this.memoryCache.keys()) {
      if (pattern.test(key)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => {
      this.memoryCache.delete(key);
      this.cacheExpiry.delete(key);
    });
    return keysToDelete.length;
  },

  // Middleware compatibility methods
  get(key, userId = '') {
    return this.getMemoryCache(key);
  },

  set(key, data, userId = '', ttlSeconds = 300) {
    this.setMemoryCache(key, data, ttlSeconds * 1000);
  },

  deleteByPattern(pattern, userId = '') {
    return this.invalidateCache(pattern, userId);
  },

  clear() {
    this.clearAllMemoryCache();
  },

  getStats() {
    return this.getCacheStats();
  },

  // Additional method for clearing user-specific cache
  clearUserCache(userId) {
    const keysToDelete = [];
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => {
      this.memoryCache.delete(key);
      this.cacheExpiry.delete(key);
    });
    return { deletedCount: keysToDelete.length };
  }
};

// Clean expired cache entries every 5 minutes
setInterval(() => {
  const cleaned = cacheService.cleanExpiredCache();
  if (cleaned > 0) {
  }
}, 5 * 60 * 1000);

module.exports = cacheService;
