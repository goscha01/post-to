const cacheService = require('../services/cacheService');

/**
 * Generate cache key from request
 * @param {object} req - Express request object
 * @param {string} userId - User ID
 * @returns {string} - Cache key
 */
const generateCacheKey = (req, userId) => {
  const path = req.originalUrl || req.url;
  const query = Object.keys(req.query).sort().map(key => `${key}=${req.query[key]}`).join('&');
  const userPrefix = userId ? `user:${userId}:` : 'public:';
  return `${userPrefix}${path}${query ? `?${query}` : ''}`;
};

/**
 * Get cache TTL based on path
 * @param {string} path - Request path
 * @returns {number} - TTL in seconds
 */
const getCacheTTL = (path) => {
  if (path.includes('/accounts') && !path.includes('/locations')) {
    return 3600; // Accounts list: 1 hour
  }
  if (path.includes('/locations')) {
    return 300; // Locations data: 5 minutes
  }
  if (path.includes('/reviews')) {
    return 180; // Reviews: 3 minutes
  }
  if (path.includes('/posts')) {
    return 180; // Posts: 3 minutes
  }
  if (path.includes('/media')) {
    return 86400; // Media (less frequent changes): 24 hours
  }
  if (path.includes('/insights')) {
    return 3600; // Insights: 1 hour
  }
  return 60; // Default: 1 minute
};

/**
 * Cache utility functions for common operations
 */
class CacheUtils {
  /**
   * Cache GMB accounts data
   * @param {string} userId - User ID
   * @param {array} accounts - Accounts data
   * @param {number} ttl - Time to live in milliseconds
   */
  static cacheGmbAccounts(userId, accounts, ttl = 10 * 60 * 1000) {
    cacheService.cacheApiResponse('gmb/accounts', {}, accounts, userId, ttl);
  }

  /**
   * Get cached GMB accounts data
   * @param {string} userId - User ID
   * @returns {array|null} - Cached accounts or null
   */
  static getCachedGmbAccounts(userId) {
    return cacheService.getCachedApiResponse('gmb/accounts', {}, userId);
  }

  /**
   * Cache GMB locations data
   * @param {string} userId - User ID
   * @param {string} accountId - Account ID
   * @param {array} locations - Locations data
   * @param {number} ttl - Time to live in milliseconds
   */
  static cacheGmbLocations(userId, accountId, locations, ttl = 10 * 60 * 1000) {
    cacheService.cacheApiResponse('gmb/accounts/locations', { accountId }, locations, userId, ttl);
  }

  /**
   * Get cached GMB locations data
   * @param {string} userId - User ID
   * @param {string} accountId - Account ID
   * @returns {array|null} - Cached locations or null
   */
  static getCachedGmbLocations(userId, accountId) {
    return cacheService.getCachedApiResponse('gmb/accounts/locations', { accountId }, userId);
  }

  /**
   * Cache GMB media data
   * @param {string} userId - User ID
   * @param {string} accountId - Account ID
   * @param {string} locationId - Location ID
   * @param {object} mediaData - Media data
   * @param {number} ttl - Time to live in milliseconds
   */
  static cacheGmbMedia(userId, accountId, locationId, mediaData, ttl = 15 * 60 * 1000) {
    cacheService.cacheApiResponse('posts/accounts/locations/media', { accountId, locationId }, mediaData, userId, ttl);
  }

  /**
   * Get cached GMB media data
   * @param {string} userId - User ID
   * @param {string} accountId - Account ID
   * @param {string} locationId - Location ID
   * @returns {object|null} - Cached media data or null
   */
  static getCachedGmbMedia(userId, accountId, locationId) {
    return cacheService.getCachedApiResponse('posts/accounts/locations/media', { accountId, locationId }, userId);
  }

  /**
   * Cache GMB posts data
   * @param {string} userId - User ID
   * @param {string} accountId - Account ID
   * @param {string} locationId - Location ID
   * @param {array} posts - Posts data
   * @param {number} ttl - Time to live in milliseconds
   */
  static cacheGmbPosts(userId, accountId, locationId, posts, ttl = 5 * 60 * 1000) {
    cacheService.cacheApiResponse('gmb/accounts/locations/posts', { accountId, locationId }, posts, userId, ttl);
  }

  /**
   * Get cached GMB posts data
   * @param {string} userId - User ID
   * @param {string} accountId - Account ID
   * @param {string} locationId - Location ID
   * @returns {array|null} - Cached posts or null
   */
  static getCachedGmbPosts(userId, accountId, locationId) {
    return cacheService.getCachedApiResponse('gmb/accounts/locations/posts', { accountId, locationId }, userId);
  }

  /**
   * Cache GMB reviews data
   * @param {string} userId - User ID
   * @param {string} accountId - Account ID
   * @param {string} locationId - Location ID
   * @param {array} reviews - Reviews data
   * @param {number} ttl - Time to live in milliseconds
   */
  static cacheGmbReviews(userId, accountId, locationId, reviews, ttl = 10 * 60 * 1000) {
    cacheService.cacheApiResponse('gmb/accounts/locations/reviews', { accountId, locationId }, reviews, userId, ttl);
  }

  /**
   * Get cached GMB reviews data
   * @param {string} userId - User ID
   * @param {string} accountId - Account ID
   * @param {string} locationId - Location ID
   * @returns {array|null} - Cached reviews or null
   */
  static getCachedGmbReviews(userId, accountId, locationId) {
    return cacheService.getCachedApiResponse('gmb/accounts/locations/reviews', { accountId, locationId }, userId);
  }

  /**
   * Invalidate GMB cache for user
   * @param {string} userId - User ID
   * @param {string} type - Cache type to invalidate (accounts, locations, media, posts, reviews, all)
   */
  static invalidateGmbCache(userId, type = 'all') {
    const patterns = {
      accounts: 'gmb/accounts*',
      locations: 'gmb/accounts/locations*',
      media: 'posts/accounts/locations/media*',
      posts: 'gmb/accounts/locations/posts*',
      reviews: 'gmb/accounts/locations/reviews*',
      all: 'gmb*'
    };

    const pattern = patterns[type] || patterns.all;
    return cacheService.invalidateCache(pattern, userId);
  }

  /**
   * Cache business profile data
   * @param {string} userId - User ID
   * @param {string} accountId - Account ID
   * @param {object} profileData - Profile data
   * @param {number} ttl - Time to live in milliseconds
   */
  static cacheBusinessProfile(userId, accountId, profileData, ttl = 30 * 60 * 1000) {
    cacheService.cacheApiResponse('business/profile', { accountId }, profileData, userId, ttl);
  }

  /**
   * Get cached business profile data
   * @param {string} userId - User ID
   * @param {string} accountId - Account ID
   * @returns {object|null} - Cached profile data or null
   */
  static getCachedBusinessProfile(userId, accountId) {
    return cacheService.getCachedApiResponse('business/profile', { accountId }, userId);
  }

  /**
   * Cache with conditional TTL based on data type
   * @param {string} endpoint - API endpoint
   * @param {object} params - Request parameters
   * @param {any} data - Data to cache
   * @param {string} userId - User ID
   */
  static smartCache(endpoint, params, data, userId) {
    // Determine TTL based on endpoint and data type
    let ttl = 5 * 60 * 1000; // Default 5 minutes

    if (endpoint.includes('accounts')) {
      ttl = 30 * 60 * 1000; // 30 minutes for account data
    } else if (endpoint.includes('media')) {
      ttl = 60 * 60 * 1000; // 1 hour for media data
    } else if (endpoint.includes('posts')) {
      ttl = 2 * 60 * 1000; // 2 minutes for posts (more dynamic)
    } else if (endpoint.includes('reviews')) {
      ttl = 15 * 60 * 1000; // 15 minutes for reviews
    }

    cacheService.cacheApiResponse(endpoint, params, data, userId, ttl);
  }

  /**
   * Get cache statistics for debugging
   * @returns {object} - Cache statistics
   */
  static getCacheStats() {
    return cacheService.getCacheStats();
  }

  /**
   * Cache services for a category
   * @param {string} userId - User ID
   * @param {string} categoryId - Category ID
   * @param {array} services - Services data
   * @param {number} ttl - Time to live in milliseconds
   */
  static cacheServices(userId, categoryId, services, ttl = 5 * 60 * 1000) {
    const cacheKey = `services_${categoryId}`;
    cacheService.set(cacheKey, services, userId, Math.floor(ttl / 1000));
  }

  /**
   * Get cached services for a category
   * @param {string} userId - User ID
   * @param {string} categoryId - Category ID
   * @returns {array|null} - Cached services or null
   */
  static getCachedServices(userId, categoryId) {
    const cacheKey = `services_${categoryId}`;
    return cacheService.get(cacheKey, userId);
  }

  /**
   * Cache existing services for a location
   * @param {string} userId - User ID
   * @param {string} locationId - Location ID
   * @param {array} services - Services data
   * @param {number} ttl - Time to live in milliseconds
   */
  static cacheExistingServices(userId, locationId, services, ttl = 2 * 60 * 1000) {
    const cacheKey = `existing_services_${locationId}`;
    cacheService.set(cacheKey, services, userId, Math.floor(ttl / 1000));
  }

  /**
   * Get cached existing services for a location
   * @param {string} userId - User ID
   * @param {string} locationId - Location ID
   * @returns {array|null} - Cached services or null
   */
  static getCachedExistingServices(userId, locationId) {
    const cacheKey = `existing_services_${locationId}`;
    return cacheService.get(cacheKey, userId);
  }

  /**
   * Clear all cache for user
   * @param {string} userId - User ID
   */
  static async clearUserCache(userId) {
    return await cacheService.clearUserCache(userId);
  }
}

module.exports = {
  CacheUtils,
  generateCacheKey,
  getCacheTTL,
};
