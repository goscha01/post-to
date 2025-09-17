/**
 * Simple TTL Configuration
 * Cache expires on logout or after configurable duration
 */

class SessionCacheConfig {
  constructor() {
    // Session state - true session-based caching
    this.isSessionActive = true;
    this.sessionStartTime = Date.now();
  }

  /**
   * Get TTL for a specific data type
   * @param {string} dataType - Type of data (businessProfiles, posts, reviews, services, userProfile)
   * @returns {number} TTL in milliseconds
   */
  getTTL(dataType) {
    // If session is not active, return 0 (no caching)
    if (!this.isSessionActive) {
      return 0;
    }
    
    // Return a very large TTL (effectively infinite) for active session
    // This represents "until logout" caching
    return 365 * 24 * 60 * 60 * 1000; // 1 year (effectively infinite for session)
  }

  /**
   * Check if cache should be used based on session state
   * @param {string} dataType - Type of data
   * @returns {boolean} Whether to use cache
   */
  shouldUseCache(dataType) {
    return this.isSessionActive; // Only use cache if session is active
  }


  /**
   * Clear session cache - called on logout
   */
  clearSessionCache() {
    // End current session
    this.isSessionActive = false;
    console.log('🧹 Session ended - cache disabled');
  }

  /**
   * Start new session - called on login
   */
  startNewSession() {
    // Start new session
    this.isSessionActive = true;
    this.sessionStartTime = Date.now();
    console.log('🚀 New session started - cache enabled');
  }

  /**
   * Get session duration in milliseconds
   * @returns {number} Session duration in milliseconds
   */
  getSessionDuration() {
    return Date.now() - this.sessionStartTime;
  }

  /**
   * Check if cache should be cleared based on session state
   * @param {boolean} isAuthenticated - Whether user is authenticated
   * @param {boolean} isDisconnected - Whether user is disconnected
   * @returns {boolean} Whether cache should be cleared
   */
  shouldClearCache(isAuthenticated, isDisconnected) {
    // Clear cache if user is disconnected or not authenticated
    return !isAuthenticated || isDisconnected;
  }
}

// Export singleton instance
const sessionCacheConfig = new SessionCacheConfig();

// Expose globally for debugging
if (typeof window !== 'undefined') {
  window.sessionCacheConfig = sessionCacheConfig;
}

export default sessionCacheConfig;
