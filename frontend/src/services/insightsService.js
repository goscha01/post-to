import axios from '../utils/axiosConfig';
import apiTracker from '../utils/apiTracker';
import sessionCacheConfig from '../config/sessionCacheConfig';

class InsightsService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = new Map();
    this.pendingRequests = new Map();
    // Use session-based TTL instead of fixed timeout
    this.sessionCacheConfig = sessionCacheConfig;
  }

  // Get cached data or fetch if expired
  getCachedData(key) {
    const expiry = this.cacheExpiry.get(key);
    if (!expiry || Date.now() > expiry) {
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
      return null;
    }

    const cachedData = this.cache.get(key);

    // Re-validate cached data on retrieval to ensure it's clean
    if (cachedData) {
      let dataType = null;
      if (key.startsWith('insights_')) dataType = 'insights';
      else if (key.startsWith('timeline_')) dataType = 'insights';

      // Validate cached data and update cache if it was corrupted
      const validatedData = this.validateAndCleanData(cachedData, dataType);

      // If validation changed the data, update the cache
      if (JSON.stringify(validatedData) !== JSON.stringify(cachedData)) {
        this.cache.set(key, validatedData);
      }

      return validatedData;
    }

    return cachedData;
  }

  // Set cached data with session-based expiry and validation
  setCachedData(key, data, dataType = null) {
    // Determine data type from cache key if not provided
    if (!dataType) {
      if (key.startsWith('insights_')) dataType = 'insights';
      else if (key.startsWith('timeline_')) dataType = 'insights';
    }

    // Check if we should use cache based on session
    if (!this.sessionCacheConfig.shouldUseCache(dataType)) {
      return;
    }

    // Get session-based TTL
    const ttl = this.sessionCacheConfig.getTTL(dataType);
    if (ttl <= 0) {
      return;
    }

    // Validate and clean data before caching
    const cleanedData = this.validateAndCleanData(data, dataType);
    this.cache.set(key, cleanedData);
    this.cacheExpiry.set(key, Date.now() + ttl);
    
  }

  // Validate and clean data before caching
  validateAndCleanData(data, dataType = 'unknown') {
    if (!data) return data;

    // Handle objects (insights responses)
    if (typeof data === 'object') {
      return this.validateAndCleanObjectData(data, dataType);
    }

    return data;
  }

  // Validate and clean object data
  validateAndCleanObjectData(data, dataType) {
    if (dataType === 'insights') {
      return this.cleanInsightsData(data);
    }

    return data;
  }

  // Clean insights data
  cleanInsightsData(insights) {
    if (!insights || typeof insights !== 'object') return insights;

    return {
      ...insights,
      // Ensure required fields exist
      locationMetrics: insights.locationMetrics || [],
      timeRange: insights.timeRange || null,
      // Clean metric data
      locationMetrics: Array.isArray(insights.locationMetrics) 
        ? insights.locationMetrics.map(metric => ({
            ...metric,
            metricType: metric.metricType || 'UNKNOWN',
            totalValue: metric.totalValue || 0,
            timeSeries: Array.isArray(metric.timeSeries) ? metric.timeSeries : []
          }))
        : []
    };
  }

  // Fetch insights data with caching
  async getInsights(accountId, locationId, period, customTimeRange = null, forceRefresh = false) {
    const cacheKey = `insights_${accountId}_${locationId}_${period}_${customTimeRange ? 'custom' : 'standard'}`;
    
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cachedData = this.getCachedData(cacheKey);
      if (cachedData) {
        return cachedData;
      }
    } else {
      this.cache.delete(cacheKey);
      this.cacheExpiry.delete(cacheKey);
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
      return this.pendingRequests.get(cacheKey);
    }

    // Create new request
    const requestPromise = this.fetchInsightsFromAPI(accountId, locationId, period, customTimeRange);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      
      // Only cache if we got valid data
      if (result && result.success !== false) {
        this.setCachedData(cacheKey, result);
      } else {
      }
      
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch insights from API
  async fetchInsightsFromAPI(accountId, locationId, period, customTimeRange = null) {
    try {
      const requestData = {
        accountId: accountId,
        locationId: locationId,
        metricRequests: [
          { metric: 'VIEWS_MAPS' },
          { metric: 'VIEWS_SEARCH' },
          { metric: 'ACTIONS_PHONE' },
          { metric: 'ACTIONS_WEBSITE' }
        ],
        timeRange: customTimeRange || this.getTimeRangeForPeriod(period)
      };

      
      const response = await axios.post('/api/insights/basic', requestData);
      
      if (response.data.success) {
        return response.data.data;
      } else {
        return { success: false, error: response.data.error };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Fetch timeline data with caching
  async getTimelineData(accountId, locationId, period, customTimeRange = null, forceRefresh = false) {
    const cacheKey = `timeline_${accountId}_${locationId}_${period}_${customTimeRange ? 'custom' : 'standard'}`;
    
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cachedData = this.getCachedData(cacheKey);
      if (cachedData) {
        return cachedData;
      }
    } else {
      this.cache.delete(cacheKey);
      this.cacheExpiry.delete(cacheKey);
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
      return this.pendingRequests.get(cacheKey);
    }

    // Create new request
    const requestPromise = this.fetchTimelineFromAPI(accountId, locationId, period, customTimeRange);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      
      // Only cache if we got valid data
      if (result && result.success !== false) {
        this.setCachedData(cacheKey, result);
      } else {
      }
      
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch timeline from API
  async fetchTimelineFromAPI(accountId, locationId, period, customTimeRange = null) {
    try {
      const requestData = {
        accountId: accountId,
        locationId: locationId,
        metricRequests: ['VIEWS_MAPS', 'VIEWS_SEARCH', 'ACTIONS_PHONE'].map(metric => ({ metric })),
        timeRange: customTimeRange || this.getTimeRangeForPeriod(period)
      };

      
      const response = await axios.post('/api/insights/timeline', requestData);
      
      if (response.data.success) {
        return response.data.data;
      } else {
        return { success: false, error: response.data.error };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Helper method to get time range for period
  getTimeRangeForPeriod(period) {
    const now = new Date();
    let startTime, endTime;

    switch (period) {
      case '7d':
        startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        endTime = now;
        break;
      case '30d':
        startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        endTime = now;
        break;
      case '90d':
        startTime = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        endTime = now;
        break;
      case '1y':
        startTime = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        endTime = now;
        break;
      default:
        startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        endTime = now;
    }

    return {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString()
    };
  }

  // Clear all cache
  clearCache() {
    this.cache.clear();
    this.cacheExpiry.clear();
    this.pendingRequests.clear();
  }

  // Clear insights cache specifically
  clearInsightsCache() {
    const insightsKeys = Array.from(this.cache.keys()).filter(key => 
      key.startsWith('insights_') || key.startsWith('timeline_')
    );
    insightsKeys.forEach(key => {
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
    });
  }

  // Get cache stats
  getCacheStats() {
    return {
      cacheSize: this.cache.size,
      pendingRequests: this.pendingRequests.size,
      cacheKeys: Array.from(this.cache.keys())
    };
  }

  // Print API call statistics for debugging
  printAPIStats() {
    const apiStats = apiTracker.printStats();
    const cacheStats = this.getCacheStats();
    return { apiStats, cacheStats };
  }
}

// Export singleton instance
const insightsService = new InsightsService();

// Expose globally for debugging
if (typeof window !== 'undefined') {
  window.insightsService = insightsService;
}

export default insightsService;
