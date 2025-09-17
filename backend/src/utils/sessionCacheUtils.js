/**
 * Session-based cache utilities for backend
 * Provides session management and TTL configuration
 */

class SessionCacheUtils {
  constructor() {
    // Session storage (in-memory for now)
    this.sessions = new Map();
    
    // Default session duration (30 minutes)
    this.defaultSessionDuration = 30 * 60 * 1000;
    
    // TTL configurations for different data types
    this.ttlConfig = {
      businessProfiles: {
        duration: 'session', // Cache until session ends
        fallbackDuration: 15 * 60 * 1000 // 15 minutes fallback
      },
      posts: {
        duration: 10 * 60 * 1000, // 10 minutes
        fallbackDuration: 5 * 60 * 1000 // 5 minutes fallback
      },
      reviews: {
        duration: 15 * 60 * 1000, // 15 minutes
        fallbackDuration: 8 * 60 * 1000 // 8 minutes fallback
      },
      services: {
        duration: 8 * 60 * 1000, // 8 minutes
        fallbackDuration: 3 * 60 * 1000 // 3 minutes fallback
      }
    };
  }

  /**
   * Get or create session for user
   * @param {string} userId - User ID
   * @returns {object} Session object
   */
  getSession(userId) {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, {
        startTime: Date.now(),
        isActive: true,
        endTime: null,
        lastActivity: Date.now()
      });
      console.log(`🔄 Created new session for user: ${userId}`);
    }
    
    const session = this.sessions.get(userId);
    
    // Update last activity
    session.lastActivity = Date.now();
    
    // Check if session is still valid
    const sessionElapsed = Date.now() - session.startTime;
    if (sessionElapsed > this.defaultSessionDuration) {
      session.isActive = false;
      session.endTime = Date.now();
      console.log(`🔚 Session expired for user: ${userId}`);
    }
    
    return session;
  }

  /**
   * Get TTL for a specific data type and user session
   * @param {string} userId - User ID
   * @param {string} dataType - Type of data
   * @returns {number} TTL in milliseconds
   */
  getTTL(userId, dataType) {
    const session = this.getSession(userId);
    const config = this.ttlConfig[dataType];
    
    if (!config) {
      console.warn(`Unknown data type: ${dataType}, using default TTL`);
      return this.defaultSessionDuration;
    }

    // If session is not active, don't cache
    if (!session.isActive) {
      return 0;
    }

    // If session-based caching
    if (config.duration === 'session') {
      return config.fallbackDuration;
    }

    // Check if we're within session duration
    const sessionElapsed = Date.now() - session.startTime;
    if (sessionElapsed > this.defaultSessionDuration) {
      return 0; // Session expired, no caching
    }

    // Return configured duration
    return config.duration;
  }

  /**
   * Check if cache should be used based on session status
   * @param {string} userId - User ID
   * @param {string} dataType - Type of data
   * @returns {boolean} Whether to use cache
   */
  shouldUseCache(userId, dataType) {
    const session = this.getSession(userId);
    return session.isActive && this.getTTL(userId, dataType) > 0;
  }

  /**
   * Refresh session for user (reset to full duration, don't accumulate)
   * @param {string} userId - User ID
   * @param {number} additionalTime - Additional time in milliseconds (unused, kept for compatibility)
   */
  extendSession(userId, additionalTime = 15 * 60 * 1000) {
    const session = this.getSession(userId);
    if (session.isActive) {
      // Reset session start time to now, maintaining the original session duration
      session.startTime = Date.now();
      session.lastActivity = Date.now();
      console.log(`⏰ Refreshed session for user ${userId} - ${this.defaultSessionDuration / 1000 / 60} minutes remaining`);
    }
  }

  /**
   * End session for user
   * @param {string} userId - User ID
   */
  endSession(userId) {
    if (this.sessions.has(userId)) {
      const session = this.sessions.get(userId);
      session.isActive = false;
      session.endTime = Date.now();
      console.log(`🔚 Ended session for user: ${userId}`);
    }
  }

  /**
   * Get session information for user
   * @param {string} userId - User ID
   * @returns {object} Session info
   */
  getSessionInfo(userId) {
    const session = this.getSession(userId);
    const now = Date.now();
    const elapsed = now - session.startTime;
    const remaining = session.isActive ? 
      Math.max(0, this.defaultSessionDuration - elapsed) : 0;

    return {
      userId,
      isActive: session.isActive,
      startTime: session.startTime,
      endTime: session.endTime,
      lastActivity: session.lastActivity,
      elapsed: elapsed,
      remaining: remaining,
      duration: this.defaultSessionDuration
    };
  }

  /**
   * Clean up expired sessions
   * @returns {number} Number of sessions cleaned
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    const expiredUsers = [];
    
    for (const [userId, session] of this.sessions.entries()) {
      const sessionElapsed = now - session.startTime;
      if (sessionElapsed > this.defaultSessionDuration * 2) { // Double duration for cleanup
        expiredUsers.push(userId);
      }
    }
    
    expiredUsers.forEach(userId => {
      this.sessions.delete(userId);
      console.log(`🧹 Cleaned up expired session for user: ${userId}`);
    });
    
    return expiredUsers.length;
  }

  /**
   * Get all active sessions
   * @returns {Array} Array of active session info
   */
  getActiveSessions() {
    const activeSessions = [];
    
    for (const [userId, session] of this.sessions.entries()) {
      if (session.isActive) {
        activeSessions.push(this.getSessionInfo(userId));
      }
    }
    
    return activeSessions;
  }

  /**
   * Update TTL configuration for a data type
   * @param {string} dataType - Type of data
   * @param {object} config - New TTL configuration
   */
  updateTTLConfig(dataType, config) {
    if (this.ttlConfig[dataType]) {
      this.ttlConfig[dataType] = { ...this.ttlConfig[dataType], ...config };
      console.log(`⚙️ Updated TTL config for ${dataType}:`, config);
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
}

// Export singleton instance
const sessionCacheUtils = new SessionCacheUtils();

// Clean up expired sessions every 10 minutes
setInterval(() => {
  const cleaned = sessionCacheUtils.cleanupExpiredSessions();
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} expired sessions`);
  }
}, 10 * 60 * 1000);

module.exports = sessionCacheUtils;
