/**
 * Simple TTL Configuration
 * Cache expires on logout or after configurable duration
 */

class SessionCacheConfig {
  constructor() {
    // TTL configurations for different data types (in milliseconds)
    this.ttlConfig = {
      // Business profiles - cache for longer duration
      businessProfiles: 15 * 60 * 1000, // 15 minutes
      
      // Posts - cache for medium duration
      posts: 10 * 60 * 1000, // 10 minutes
      
      // Reviews - cache for medium duration
      reviews: 15 * 60 * 1000, // 15 minutes
      
      // Services/Media - cache for shorter duration
      services: 8 * 60 * 1000, // 8 minutes
      
      // User profile images - cache for longer duration
      userProfile: 24 * 60 * 60 * 1000 // 24 hours
    };
  }

  /**
   * Get TTL for a specific data type
   * @param {string} dataType - Type of data (businessProfiles, posts, reviews, services, userProfile)
   * @returns {number} TTL in milliseconds
   */
  getTTL(dataType) {
    const ttl = this.ttlConfig[dataType];
    if (!ttl) {
      console.warn(`Unknown data type: ${dataType}, using default TTL`);
      return 5 * 60 * 1000; // 5 minutes default
    }
    return ttl;
  }

  /**
   * Check if cache should be used (always true unless explicitly disabled)
   * @param {string} dataType - Type of data
   * @returns {boolean} Whether to use cache
   */
  shouldUseCache(dataType) {
    return true; // Always use cache, cleared on logout
  }

  /**
   * Update TTL configuration for a data type
   * @param {string} dataType - Type of data
   * @param {number} ttl - New TTL in milliseconds
   */
  updateTTLConfig(dataType, ttl) {
    if (this.ttlConfig.hasOwnProperty(dataType)) {
      this.ttlConfig[dataType] = ttl;
      console.log(`⚙️ Updated TTL config for ${dataType}: ${ttl / 1000 / 60} minutes`);
    } else {
      console.warn(`Unknown data type: ${dataType}`);
    }
  }

  /**
   * Get all TTL configurations
   * @returns {object} All TTL configurations
   */
  getAllTTLConfigs() {
    return { ...this.ttlConfig };
  }

  /**
   * Reset to default configurations
   */
  resetToDefaults() {
    this.ttlConfig = {
      businessProfiles: 15 * 60 * 1000, // 15 minutes
      posts: 10 * 60 * 1000, // 10 minutes
      reviews: 15 * 60 * 1000, // 15 minutes
      services: 8 * 60 * 1000, // 8 minutes
      userProfile: 24 * 60 * 60 * 1000 // 24 hours
    };
    console.log('🔄 Reset TTL configurations to defaults');
  }
}

// Export singleton instance
const sessionCacheConfig = new SessionCacheConfig();

// Expose globally for debugging
if (typeof window !== 'undefined') {
  window.sessionCacheConfig = sessionCacheConfig;
}

export default sessionCacheConfig;
