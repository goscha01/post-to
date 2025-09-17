import imageService from './imageService';
import sessionCacheConfig from '../config/sessionCacheConfig';
import axios from '../utils/axiosConfig';

class ServicesMediaService {
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
    return this.cache.get(key);
  }

  // Get cached image or fetch if expired
  getCachedImage(url) {
    return this.getCachedData(url);
  }

  // Set cached data with session-based expiry
  setCachedData(key, data, dataType = 'services') {
    // Check if we should use cache based on session
    if (!this.sessionCacheConfig.shouldUseCache(dataType)) {
      console.log(`🚫 Skipping cache for ${key} - session expired or cache disabled`);
      return;
    }

    // Get session-based TTL
    const ttl = this.sessionCacheConfig.getTTL(dataType);
    if (ttl <= 0) {
      console.log(`🚫 Skipping cache for ${key} - TTL is 0`);
      return;
    }

    this.cache.set(key, data);
    this.cacheExpiry.set(key, Date.now() + ttl);
    
    console.log(`💾 Cached ${key} with session-based TTL: ${ttl / 1000 / 60} minutes`);
  }

  // Set cached image with session-based expiry
  setCachedImage(url, dataUrl) {
    this.setCachedData(url, dataUrl, 'services');
  }

  // Fetch services for a specific category with caching
  async getServicesForCategory(categoryId, forceRefresh = false) {
    const cacheKey = `services_category_${categoryId}`;
    
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cachedData = this.getCachedData(cacheKey);
      if (cachedData) {
        console.log(`📦 Using cached services for category ${categoryId}`);
        return cachedData;
      }
    } else {
      this.cache.delete(cacheKey);
      this.cacheExpiry.delete(cacheKey);
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ Request already in progress for ${cacheKey}`);
      return this.pendingRequests.get(cacheKey);
    }

    // Create new request
    const requestPromise = this.fetchServicesFromAPI(categoryId, forceRefresh);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      
      // Only cache if we got valid data
      if (result && Array.isArray(result) && result.length >= 0) {
        console.log(`💾 Storing ${result.length} services in cache for category ${categoryId}`);
        this.setCachedData(cacheKey, result);
      } else {
        console.log(`⚠️ Not caching invalid data for category ${categoryId}`);
      }
      
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch services from API with cache-first loading
  async fetchServicesFromAPI(categoryId, forceRefresh = false) {
    console.log(`🔍 fetchServicesFromAPI called for categoryId: ${categoryId}, forceRefresh: ${forceRefresh}`);
    
    try {
      // Always try backend cache first (unless force refresh)
      if (!forceRefresh) {
        try {
          console.log(`📦 Fetching from backend cache: /api/services/categories/${categoryId}?cached_only=true`);
          const cachedResponse = await axios.get(`/api/services/categories/${categoryId}?cached_only=true`);
          
          if (cachedResponse.data.success && cachedResponse.data.cached) {
            const cachedServices = cachedResponse.data.services || [];
            console.log(`📦 Successfully fetched ${cachedServices.length} services from BACKEND cache`);
            
            // Only return cached services if there are actually services in the cache
            if (cachedServices.length > 0) {
              return cachedServices;
            } else {
              console.log(`📦 Backend cache is empty, will fetch from GMB API`);
            }
          }
        } catch (cacheError) {
          console.log(`💾 Backend cache not available for category ${categoryId}, will fetch from API. Error:`, {
            message: cacheError.message,
            status: cacheError.response?.status,
            statusText: cacheError.response?.statusText,
            data: cacheError.response?.data
          });
        }
      } else {
        console.log(`🔄 Force refresh requested, skipping backend cache`);
      }

      // If no cached data or force refresh, fetch from API
      console.log(`🌐 Fetching services from GMB API: /api/gmb/categories/batchGet`);
      const response = await axios.get(`/api/gmb/categories/batchGet`, {
        params: {
          names: categoryId,
          regionCode: 'US',
          languageCode: 'en',
          view: 'FULL'
        }
      });
      
      console.log(`🌐 Successfully fetched services from GMB API`);
      
      if (response.data.success && response.data.categories.length > 0) {
        const category = response.data.categories[0];
        
        if (category.serviceTypes && Array.isArray(category.serviceTypes) && category.serviceTypes.length > 0) {
          // Check if services have valid data
          const hasValidServices = category.serviceTypes.some(service => 
            service.displayName || service.serviceTypeId
          );
          
          if (hasValidServices) {
            const services = category.serviceTypes.map(service => {
              // Handle both structured and free-form services
              if (service.serviceTypeId) {
                // Structured service
                let serviceName = service.displayName;
                if (!serviceName && service.serviceTypeId) {
                  // Extract name from serviceTypeId if displayName is missing
                  serviceName = service.serviceTypeId.split('/').pop().replace(/_/g, ' ');
                }
                
                return {
                  id: service.serviceTypeId,
                  name: serviceName,
                  displayName: serviceName,
                  serviceTypeId: service.serviceTypeId,
                  categoryId: categoryId,
                  isStructured: true
                };
              } else {
                // Free-form service
                return {
                  id: service.name || `freeform_${Date.now()}`,
                  name: service.displayName || service.name,
                  displayName: service.displayName || service.name,
                  serviceTypeId: null,
                  categoryId: categoryId,
                  isStructured: false
                };
              }
            });
            
            return services;
          }
        }
      }
      
      return [];
    } catch (error) {
      console.error(`❌ Error fetching services for category ${categoryId}:`, error);
      console.error(`❌ Error details:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        url: error.config?.url,
        method: error.config?.method
      });
      return [];
    }
  }

  // Fetch existing services for a location with caching
  async getExistingServicesForLocation(locationId, forceRefresh = false) {
    const cacheKey = `existing_services_${locationId}`;
    
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cachedData = this.getCachedData(cacheKey);
      if (cachedData) {
        console.log(`📦 Using cached existing services for location ${locationId}`);
        return cachedData;
      }
    } else {
      this.cache.delete(cacheKey);
      this.cacheExpiry.delete(cacheKey);
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ Request already in progress for ${cacheKey}`);
      return this.pendingRequests.get(cacheKey);
    }

    // Create new request
    const requestPromise = this.fetchExistingServicesFromAPI(locationId, forceRefresh);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      
      // Only cache if we got valid data
      if (result && Array.isArray(result) && result.length >= 0) {
        console.log(`💾 Storing ${result.length} existing services in cache for location ${locationId}`);
        this.setCachedData(cacheKey, result);
      } else {
        console.log(`⚠️ Not caching invalid data for location ${locationId}`);
      }
      
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch existing services from API with cache-first loading
  async fetchExistingServicesFromAPI(locationId, forceRefresh = false) {
    console.log(`🔍 fetchExistingServicesFromAPI called for locationId: ${locationId}, forceRefresh: ${forceRefresh}`);
    
    try {
      // Always try backend cache first (unless force refresh)
      if (!forceRefresh) {
        try {
          console.log(`📦 Fetching from backend cache: /api/gmb/locations/${locationId}/services?cached_only=true`);
          const cachedResponse = await axios.get(`/api/gmb/locations/${locationId}/services?cached_only=true`);
          
          if (cachedResponse.data.success && cachedResponse.data.cached) {
            const cachedServices = cachedResponse.data.serviceItems || [];
            console.log(`📦 Successfully fetched ${cachedServices.length} existing services from BACKEND cache`);
            
            // Only return cached services if there are actually services in the cache
            if (cachedServices.length > 0) {
              return cachedServices;
            } else {
              console.log(`📦 Backend cache is empty, will fetch from GMB API`);
            }
          }
        } catch (cacheError) {
          console.log(`💾 Backend cache not available for location ${locationId}, will fetch from API. Error:`, {
            message: cacheError.message,
            status: cacheError.response?.status,
            statusText: cacheError.response?.statusText,
            data: cacheError.response?.data
          });
        }
      } else {
        console.log(`🔄 Force refresh requested, skipping backend cache`);
      }

      // If no cached data or force refresh, fetch from API
      console.log(`🌐 Fetching existing services from GMB API: /api/gmb/locations/${locationId}/services`);
      const response = await axios.get(`/api/gmb/locations/${locationId}/services`);
      
      console.log(`🌐 Successfully fetched existing services from GMB API`);
      return response.data.serviceItems || [];
    } catch (error) {
      console.error(`❌ Error fetching existing services for location ${locationId}:`, error);
      console.error(`❌ Error details:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        url: error.config?.url,
        method: error.config?.method
      });
      return [];
    }
  }

  // Process media for services (if any images are needed)
  async getMediaForServices(services) {
    if (!services || services.length === 0) return services;

    // For now, services don't typically have images, but this structure
    // allows for future expansion if service images are added
    return services;
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
    this.cacheExpiry.clear();
  }

  // Get cache stats
  getCacheStats() {
    return {
      cacheSize: this.cache.size,
      cacheKeys: Array.from(this.cache.keys())
    };
  }
}

export default new ServicesMediaService();
