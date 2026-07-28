const cacheService = require('../services/cacheService');
const { generateCacheKey } = require('../utils/cacheUtils');
const sessionCacheUtils = require('../utils/sessionCacheUtils');

/**
 * Cache middleware for API routes
 * @param {object} options - Cache options
 * @param {number} options.ttl - Time to live in milliseconds
 * @param {boolean} options.usePersistentCache - Whether to use persistent cache
 * @param {function} options.keyGenerator - Custom key generator function
 * @param {array} options.skipCacheFor - Array of conditions to skip caching
 */
const cacheMiddleware = (options = {}) => {
  const {
    ttl = 5 * 60 * 1000, // 5 minutes default
    usePersistentCache = false,
    keyGenerator = null,
    skipCacheFor = [],
    sessionBased = false, // Enable session-based TTL
    dataType = 'default' // Data type for session-based TTL
  } = options;

  return async (req, res, next) => {
    // Skip caching for certain conditions
    for (const condition of skipCacheFor) {
      if (typeof condition === 'function' && condition(req)) {
        return next();
      }
      if (typeof condition === 'string' && req.method !== condition) {
        return next();
      }
    }

    // Skip caching for non-GET requests by default
    if (req.method !== 'GET') {
      return next();
    }

    const userId = req.user?.userId || '';
    const endpoint = req.route?.path || req.path;
    const params = { ...req.query, ...req.params };

    // Generate cache key
    const cacheKey = keyGenerator 
      ? keyGenerator(req)
      : generateCacheKey(req, userId);

    try {
      // Try to get from cache
      let cachedData = null;
      
      cachedData = await cacheService.get(cacheKey, userId);

      if (cachedData) {
        return res.json({
          success: true,
          data: cachedData,
          cached: true,
          cacheTimestamp: new Date().toISOString()
        });
      }

      
      // Store original res.json method
      const originalJson = res.json.bind(res);
      
      // Override res.json to cache the response
      res.json = function(data) {
        // Only cache successful responses
        if (data && (data.success !== false)) {
          let cacheTTL = ttl;
          
          // Use session-based TTL if enabled
          if (sessionBased) {
            // Check if we should use cache based on session
            if (!sessionCacheUtils.shouldUseCache(userId, dataType)) {
              return originalJson(data);
            }
            
            // Get session-based TTL
            cacheTTL = sessionCacheUtils.getTTL(userId, dataType);
            if (cacheTTL <= 0) {
              return originalJson(data);
            }
            
          }
          
          cacheService.set(cacheKey, data, userId, Math.floor(cacheTTL / 1000));
        }
        
        // Call original json method
        return originalJson(data);
      };

      next();
    } catch (error) {
      next();
    }
  };
};

/**
 * Cache invalidation middleware
 * @param {string} pattern - Cache pattern to invalidate
 */
const invalidateCacheMiddleware = (patternOrOpts = '*') => {
  // Historical callers pass either a string ('user:*:posts*') or an
  // options object ({ pattern: 'user:*:posts*' }). The downstream
  // cacheService.deleteByPattern expects a string and does endpoint.replace
  // on it — throws "endpoint.replace is not a function" on the object
  // form, and the throw happened inside a wrapped res.json which broke
  // every /api/posts success response with a 45s hang. Normalize here.
  const pattern =
    typeof patternOrOpts === 'string'
      ? patternOrOpts
      : (patternOrOpts && typeof patternOrOpts === 'object' && typeof patternOrOpts.pattern === 'string')
        ? patternOrOpts.pattern
        : '*';

  return async (req, res, next) => {
    const userId = req.user?.userId || '';

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    const safeInvalidate = () => {
      try {
        cacheService.deleteByPattern(pattern, userId);
      } catch (err) {
        // Never let cache invalidation throw inside res.json/send — it
        // used to eat the response and hang the request until timeout.
        // eslint-disable-next-line no-console
        console.warn('invalidateCacheMiddleware: cache delete failed', err?.message);
      }
    };

    res.json = function(data) {
      if (data && (data.success !== false)) safeInvalidate();
      return originalJson(data);
    };

    res.send = function(data) {
      if (data && (data.success !== false)) safeInvalidate();
      return originalSend(data);
    };

    next();
  };
};

/**
 * Cache statistics middleware
 */
const cacheStatsMiddleware = async (req, res, next) => {
  try {
    const stats = cacheService.getStats();
    res.json({
      success: true,
      cache: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get cache statistics'
    });
  }
};

/**
 * Clear cache middleware
 */
const clearCacheMiddleware = async (req, res, next) => {
  try {
    const userId = req.user?.userId || '';
    const { pattern = '*', type = 'memory' } = req.body;
    
    let result;
    
    if (type === 'persistent') {
      result = await cacheService.clearUserCache(userId);
    } else if (type === 'all') {
      result = await cacheService.clearUserCache(userId);
      cacheService.clear();
    } else {
      result = { memoryCleared: cacheService.deleteByPattern(pattern, userId) };
    }
    
    res.json({
      success: true,
      message: 'Cache cleared successfully',
      result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to clear cache'
    });
  }
};

module.exports = {
  cacheMiddleware,
  invalidateCacheMiddleware,
  cacheStatsMiddleware,
  clearCacheMiddleware
};
