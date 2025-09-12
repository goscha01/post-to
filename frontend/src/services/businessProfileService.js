import axios from 'axios';
import apiTracker from '../utils/apiTracker';

class BusinessProfileService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = new Map();
    this.pendingRequests = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  // Get cached data or fetch if expired
  getCachedData(key) {
    const expiry = this.cacheExpiry.get(key);
    if (!expiry || Date.now() > expiry) {
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
      return null;
    }
    return this.cache.get(key);
  }

  // Set cached data with expiry
  setCachedData(key, data) {
    this.cache.set(key, data);
    this.cacheExpiry.set(key, Date.now() + this.cacheTimeout);
  }

  // Fetch business accounts with caching
  async getAccounts() {
    const cacheKey = 'accounts';
    
    // Check cache first
    const cachedData = this.getCachedData(cacheKey);
    if (cachedData) {
      console.log('📦 Using cached accounts data');
      return cachedData;
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
      console.log('⏳ Accounts request already in progress, waiting...');
      return this.pendingRequests.get(cacheKey);
    }

    // Create new request
    const requestPromise = this.fetchAccountsFromAPI();
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      this.setCachedData(cacheKey, result);
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch accounts from API
  async fetchAccountsFromAPI() {
    try {
      console.log('🌐 [API CALL] Fetching accounts from API');
      apiTracker.logCall('http://localhost:3001/api/gmb/accounts', 'GET', 'BusinessProfileService');
      const response = await axios.get('http://localhost:3001/api/gmb/accounts');
      
      if (response.data.accounts) {
        // Fetch locations for each account
        const profilesWithLocations = await Promise.all(
          response.data.accounts.map(async (account) => {
            try {
              const accountId = account.name.split('/').pop();
              const locations = await this.getLocationsForAccount(accountId);
              
              const locationsWithAccount = locations.map(location => ({
                ...location,
                accountId: accountId,
                fullPath: `accounts/${accountId}/locations/${location.name.split('/').pop()}`
              }));
              
              return {
                ...account,
                locations: locationsWithAccount
              };
            } catch (error) {
              console.error(`Error fetching locations for account ${account.name}:`, error);
              return { ...account, locations: [] };
            }
          })
        );
        
        return profilesWithLocations;
      }
      
      return [];
    } catch (error) {
      console.error('Error fetching accounts:', error);
      throw error;
    }
  }

  // Fetch locations for a specific account with caching
  async getLocationsForAccount(accountId) {
    const cacheKey = `locations_${accountId}`;
    
    // Check cache first
    const cachedData = this.getCachedData(cacheKey);
    if (cachedData) {
      console.log(`📦 Using cached locations for account ${accountId}`);
      return cachedData;
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ Locations request for account ${accountId} already in progress, waiting...`);
      return this.pendingRequests.get(cacheKey);
    }

    // Create new request
    const requestPromise = this.fetchLocationsFromAPI(accountId);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      this.setCachedData(cacheKey, result);
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch locations from API
  async fetchLocationsFromAPI(accountId) {
    try {
      console.log(`🌐 [API CALL] Fetching locations for account ${accountId}`);
      const url = `http://localhost:3001/api/gmb/accounts/${accountId}/locations`;
      apiTracker.logCall(url, 'GET', 'BusinessProfileService');
      const response = await axios.get(url);
      return response.data.locations || [];
    } catch (error) {
      console.error(`Error fetching locations for account ${accountId}:`, error);
      return [];
    }
  }

  // Get media for a specific location with caching
  async getMediaForLocation(accountId, locationId) {
    const cacheKey = `media_${accountId}_${locationId}`;
    
    // Check cache first
    const cachedData = this.getCachedData(cacheKey);
    if (cachedData) {
      console.log(`📦 Using cached media for location ${locationId}`);
      return cachedData;
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ Media request for location ${locationId} already in progress, waiting...`);
      return this.pendingRequests.get(cacheKey);
    }

    // Create new request
    const requestPromise = this.fetchMediaFromAPI(accountId, locationId);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      this.setCachedData(cacheKey, result);
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch media from API
  async fetchMediaFromAPI(accountId, locationId) {
    try {
      console.log(`🌐 [API CALL] Fetching media for location ${locationId}`);
      const url = `http://localhost:3001/api/posts/accounts/${accountId}/locations/${locationId}/media`;
      apiTracker.logCall(url, 'GET', 'BusinessProfileService');
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      console.error(`Error fetching media for location ${locationId}:`, error);
      return { profilePicture: null, logos: [], photos: [], businessImages: [] };
    }
  }

  // Clear all cache
  clearCache() {
    this.cache.clear();
    this.cacheExpiry.clear();
    this.pendingRequests.clear();
    console.log('🗑️ Business profile cache cleared');
  }

  // Get reviews for a specific location with caching
  async getReviewsForLocation(accountId, locationId) {
    const cacheKey = `reviews_${accountId}_${locationId}`;
    
    // Check cache first
    const cachedData = this.getCachedData(cacheKey);
    if (cachedData) {
      console.log(`📦 Using cached reviews for location ${locationId}`);
      return cachedData;
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ Reviews request for location ${locationId} already in progress, waiting...`);
      return this.pendingRequests.get(cacheKey);
    }

    // Create new request
    const requestPromise = this.fetchReviewsFromAPI(accountId, locationId);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      this.setCachedData(cacheKey, result);
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch reviews from API
  async fetchReviewsFromAPI(accountId, locationId) {
    try {
      console.log(`🌐 [API CALL] Fetching reviews for location ${locationId}`);
      const url = `http://localhost:3001/api/gmb/accounts/${accountId}/locations/${locationId}/reviews`;
      apiTracker.logCall(url, 'GET', 'BusinessProfileService');
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      console.error(`Error fetching reviews for location ${locationId}:`, error);
      return { reviews: [], totalReviews: 0, averageRating: 0 };
    }
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
    console.log('📊 Combined Stats:', { apiStats, cacheStats });
    return { apiStats, cacheStats };
  }
}

// Export singleton instance
const businessProfileService = new BusinessProfileService();

// Expose API tracker globally for debugging
if (typeof window !== 'undefined') {
  window.businessProfileService = businessProfileService;
  window.apiTracker = apiTracker;
  console.log('🔧 Debug tools available: window.businessProfileService.printAPIStats()');
}

export default businessProfileService;
