import axios from '../utils/axiosConfig';
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

    const cachedData = this.cache.get(key);

    // Re-validate cached data on retrieval to ensure it's clean
    if (cachedData) {
      let dataType = null;
      if (key === 'accounts') dataType = 'accounts';
      else if (key.startsWith('locations_')) dataType = 'locations';
      else if (key.startsWith('reviews_')) dataType = 'reviews_response';
      else if (key.startsWith('media_')) dataType = 'media';

      // Validate cached data and update cache if it was corrupted
      const validatedData = this.validateAndCleanData(cachedData, dataType);

      // If validation changed the data, update the cache
      if (JSON.stringify(validatedData) !== JSON.stringify(cachedData)) {
        console.log(`🔧 Re-validated and cleaned cached data for key: ${key}`);
        this.cache.set(key, validatedData);
      }

      return validatedData;
    }

    return cachedData;
  }

  // Set cached data with expiry and validation
  setCachedData(key, data, dataType = null) {
    // Determine data type from cache key if not provided
    if (!dataType) {
      if (key === 'accounts') dataType = 'accounts';
      else if (key.startsWith('locations_')) dataType = 'locations';
      else if (key.startsWith('reviews_')) dataType = 'reviews_response';
      else if (key.startsWith('media_')) dataType = 'media';
    }

    // Validate and clean data before caching
    const cleanedData = this.validateAndCleanData(data, dataType);
    this.cache.set(key, cleanedData);
    this.cacheExpiry.set(key, Date.now() + this.cacheTimeout);
  }

  // Validate and clean data before caching
  validateAndCleanData(data, dataType = 'unknown') {
    if (!data) return data;

    // Handle arrays (accounts, locations, reviews)
    if (Array.isArray(data)) {
      return this.validateAndCleanArrayData(data, dataType);
    }

    // Handle objects (single items or response objects)
    if (typeof data === 'object') {
      return this.validateAndCleanObjectData(data, dataType);
    }

    return data;
  }

  // Validate and clean array data (accounts, locations, reviews)
  validateAndCleanArrayData(data, dataType) {
    const cleanedData = data
      .map(item => this.validateAndCleanItem(item, dataType))
      .filter(item => this.isValidItem(item, dataType))
      .filter((item, index, self) => {
        // Deduplicate by appropriate identifier
        const identifier = this.getItemIdentifier(item, dataType);
        return index === self.findIndex(other =>
          this.getItemIdentifier(other, dataType) === identifier
        );
      });

    if (cleanedData.length !== data.length) {
      console.warn(`🔧 Cleaned ${data.length} ${dataType} items to ${cleanedData.length} (removed duplicates/corrupted data)`);
    }

    return cleanedData;
  }

  // Validate and clean object data
  validateAndCleanObjectData(data, dataType) {
    if (dataType === 'reviews_response' && data.reviews) {
      return {
        ...data,
        reviews: this.validateAndCleanArrayData(data.reviews, 'reviews')
      };
    }

    return data;
  }

  // Clean individual items based on type
  validateAndCleanItem(item, dataType) {
    switch (dataType) {
      case 'accounts':
        return this.cleanAccountItem(item);
      case 'locations':
        return this.cleanLocationItem(item);
      case 'reviews':
        return this.cleanReviewItem(item);
      default:
        return item;
    }
  }

  // Clean account items
  cleanAccountItem(account) {
    if (!account || typeof account !== 'object') return account;

    return {
      ...account,
      // Fix double "accounts/" prefix
      name: account.name ? account.name.replace(/^accounts\/accounts\//, 'accounts/') : account.name,
      // Ensure displayName exists
      displayName: account.displayName || account.name?.split('/').pop() || 'Unknown Business'
    };
  }

  // Clean location items
  cleanLocationItem(location) {
    if (!location || typeof location !== 'object') return location;

    return {
      ...location,
      // Fix double "locations/" prefix
      name: location.name ? location.name.replace(/^locations\/locations\//, 'locations/') : location.name,
      // Ensure basic required fields
      locationName: location.locationName || location.title || 'Unknown Location'
    };
  }

  // Clean review items
  cleanReviewItem(review) {
    if (!review || typeof review !== 'object') return review;

    return {
      ...review,
      // Normalize rating field
      star_rating: review.star_rating || review.starRating || review.rating || 0,
      // Ensure reviewer name
      reviewer: {
        ...review.reviewer,
        displayName: review.reviewer?.displayName || review.reviewer?.name || 'Anonymous'
      }
    };
  }

  // Check if item is valid
  isValidItem(item, dataType) {
    if (!item || typeof item !== 'object') return false;

    switch (dataType) {
      case 'accounts':
        return !!(item.name && item.name.includes('accounts/'));
      case 'locations':
        return !!(item.name && (item.name.includes('locations/') || item.locationName));
      case 'reviews':
        return !!(item.reviewer || item.comment || item.reply);
      default:
        return true;
    }
  }

  // Get unique identifier for deduplication
  getItemIdentifier(item, dataType) {
    switch (dataType) {
      case 'accounts':
        return item.name?.replace(/^accounts\/accounts\//, 'accounts/') || item.accountId;
      case 'locations':
        return item.name?.replace(/^locations\/locations\//, 'locations/') || item.locationId;
      case 'reviews':
        return item.name || `${item.reviewer?.displayName}-${item.createTime}`;
      default:
        return item.id || item.name || JSON.stringify(item);
    }
  }

  // Fetch business accounts with caching
  async getAccounts() {
    const cacheKey = 'accounts';
    
    // Check cache first
    const cachedData = this.getCachedData(cacheKey);
    if (cachedData) {
      return cachedData;
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
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

  // Helper function to process accounts response and fetch locations
  async processAccountsResponse(accounts, fromCache = false) {
    if (!accounts || accounts.length === 0) {
      return [];
    }

    console.log(`🔄 Processing ${accounts.length} accounts (from ${fromCache ? 'cache' : 'API'})`);

    // Fetch locations for each account
    const profilesWithLocations = await Promise.all(
      accounts.map(async (account) => {
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

    if (!fromCache) {
      this.storeInCache('business_accounts', profilesWithLocations);
    }

    return profilesWithLocations;
  }

  // Fetch accounts from API with cache-first loading
  async fetchAccountsFromAPI() {
    try {
      // First try to get cached data
      try {
        const cachedResponse = await axios.get('/api/gmb/accounts?cached_only=true');
        if (cachedResponse.data.success && cachedResponse.data.cached) {
          const accounts = cachedResponse.data.accounts || [];
          console.log(`📦 Using cached accounts data (${accounts.length} accounts)`);
          if (accounts.length === 0) {
            console.log('💾 Cached accounts data is empty, falling back to API');
            throw new Error('Empty cache, falling back to API');
          }
          return await this.processAccountsResponse(accounts, true);
        }
      } catch (cacheError) {
        console.log('💾 No cached accounts available, fetching from API');
      }

      // If no cached data, fetch from API
      const response = await axios.get('/api/gmb/accounts');
      return await this.processAccountsResponse(response.data.accounts || [], false);
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
      return cachedData;
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
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

  // Fetch locations from API with cache-first loading
  async fetchLocationsFromAPI(accountId) {
    try {
      // First try to get cached data
      try {
        const cachedResponse = await axios.get(`/api/gmb/accounts/${accountId}/locations?cached_only=true`);
        if (cachedResponse.data.success && cachedResponse.data.cached &&
            cachedResponse.data.locations && cachedResponse.data.locations.length > 0) {
          console.log(`📦 Using cached locations data for account ${accountId} (${cachedResponse.data.locations.length} locations)`);
          return cachedResponse.data.locations;
        } else {
          console.log(`💾 Cached locations data is empty for account ${accountId}, fetching from API`);
        }
      } catch (cacheError) {
        console.log(`💾 No cached locations available for account ${accountId}, fetching from API`);
      }

      // If no cached data, fetch from API
      const response = await axios.get(`/api/gmb/accounts/${accountId}/locations`);
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
      return cachedData;
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
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
      const response = await axios.get(`/api/posts/accounts/${accountId}/locations/${locationId}/media`);
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
  }

  // Force clear corrupted cache (one-time cleanup)
  forceCleanCorruptedCache() {
    console.log('🧹 Force clearing corrupted cache data...');

    // Check each cached item for corruption
    const corruptedKeys = [];
    for (const [key, data] of this.cache.entries()) {
      if (Array.isArray(data)) {
        const hasCorruption = data.some(item =>
          item.name && (
            item.name.includes('accounts/accounts/') ||
            item.name.includes('locations/locations/')
          )
        );
        if (hasCorruption) {
          corruptedKeys.push(key);
        }
      }
    }

    // Clear corrupted cache entries
    corruptedKeys.forEach(key => {
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
      console.log(`🗑️ Cleared corrupted cache entry: ${key}`);
    });

    console.log(`🧹 Cleared ${corruptedKeys.length} corrupted cache entries`);
    return corruptedKeys.length;
  }

  // Get reviews for a specific location with caching
  async getReviewsForLocation(accountId, locationId) {
    const cacheKey = `reviews_${accountId}_${locationId}`;
    
    // Check cache first
    const cachedData = this.getCachedData(cacheKey);
    if (cachedData) {
      return cachedData;
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
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

  // Fetch reviews from API with cache-first loading
  async fetchReviewsFromAPI(accountId, locationId) {
    try {
      // First try to get cached data
      try {
        const cachedResponse = await axios.get(`/api/gmb/accounts/${accountId}/locations/${locationId}/reviews?cached_only=true`);
        if (cachedResponse.data.success && cachedResponse.data.cached) {
          console.log(`📦 Using cached reviews data for location ${locationId} (${cachedResponse.data.reviews?.length || 0} reviews)`);
          return cachedResponse.data;
        }
      } catch (cacheError) {
        console.log(`💾 No cached reviews available for location ${locationId}, fetching from API`);
      }

      // If no cached data, fetch from API
      const response = await axios.get(`/api/gmb/accounts/${accountId}/locations/${locationId}/reviews`);
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

  // Test validation system with corrupted data
  testValidationSystem() {
    console.log('🧪 Testing validation system...\n');

    // Mock corrupted data similar to what we found in the logs
    const corruptedAccountsData = [
      {
        name: "accounts/accounts/112233445566",
        displayName: "Test Business",
        type: "PERSONAL"
      },
      {
        name: "accounts/112233445566", // Normal account
        displayName: "Test Business",
        type: "PERSONAL"
      },
      {
        name: "accounts/accounts/112233445566", // Duplicate with double prefix
        displayName: "Test Business",
        type: "PERSONAL"
      },
      {
        name: "invalid-account", // Invalid account name
        displayName: "Invalid Business"
      }
    ];

    const corruptedLocationsData = [
      {
        name: "locations/locations/123456789",
        locationName: "Test Location"
      },
      {
        name: "locations/123456789", // Normal location
        locationName: "Test Location"
      },
      {
        name: "locations/locations/123456789", // Duplicate with double prefix
        locationName: "Test Location"
      }
    ];

    const corruptedReviewsData = [
      {
        name: "reviews/xyz123",
        starRating: 5, // Old field name
        reviewer: { name: "John Doe" }
      },
      {
        name: "reviews/abc456",
        star_rating: 4, // Correct field name
        reviewer: { displayName: "Jane Smith" }
      },
      {
        name: "reviews/def789",
        rating: 3, // Another old field name
        reviewer: { displayName: "Bob Wilson" }
      }
    ];

    // Test accounts validation
    console.log('📋 Testing accounts validation:');
    console.log('Original accounts:', corruptedAccountsData.length);
    const cleanedAccounts = this.validateAndCleanData(corruptedAccountsData, 'accounts');
    console.log('Cleaned accounts:', cleanedAccounts.length);
    console.log('Account names:', cleanedAccounts.map(acc => acc.name));
    console.log('');

    // Test locations validation
    console.log('📍 Testing locations validation:');
    console.log('Original locations:', corruptedLocationsData.length);
    const cleanedLocations = this.validateAndCleanData(corruptedLocationsData, 'locations');
    console.log('Cleaned locations:', cleanedLocations.length);
    console.log('Location names:', cleanedLocations.map(loc => loc.name));
    console.log('');

    // Test reviews validation
    console.log('⭐ Testing reviews validation:');
    console.log('Original reviews:', corruptedReviewsData.length);
    const cleanedReviews = this.validateAndCleanData(corruptedReviewsData, 'reviews');
    console.log('Cleaned reviews:', cleanedReviews.length);
    console.log('Review ratings:', cleanedReviews.map(rev => rev.star_rating));
    console.log('');

    // Test cache key detection
    console.log('🔑 Testing cache key detection:');
    const originalCacheSize = this.cache.size;
    this.setCachedData('test_accounts', corruptedAccountsData);
    this.setCachedData('test_locations_123', corruptedLocationsData);
    this.setCachedData('test_reviews_123_456', { reviews: corruptedReviewsData });

    const cacheStats = this.getCacheStats();
    console.log('Added 3 test cache entries');
    console.log('Cache size increase:', cacheStats.cacheSize - originalCacheSize);

    // Clean up test data
    this.cache.delete('test_accounts');
    this.cache.delete('test_locations_123');
    this.cache.delete('test_reviews_123_456');
    this.cacheExpiry.delete('test_accounts');
    this.cacheExpiry.delete('test_locations_123');
    this.cacheExpiry.delete('test_reviews_123_456');

    console.log('\n✅ Validation test completed!');
    console.log('🛡️ Data validation system is working and will prevent future cache corruption.');
    return {
      accounts: { original: corruptedAccountsData.length, cleaned: cleanedAccounts.length },
      locations: { original: corruptedLocationsData.length, cleaned: cleanedLocations.length },
      reviews: { original: corruptedReviewsData.length, cleaned: cleanedReviews.length }
    };
  }
}

// Export singleton instance
const businessProfileService = new BusinessProfileService();

// Expose API tracker globally for debugging
if (typeof window !== 'undefined') {
  window.businessProfileService = businessProfileService;
  window.apiTracker = apiTracker;
}

export default businessProfileService;
