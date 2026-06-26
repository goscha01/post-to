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
      return;
    }

    // Get session-based TTL
    const ttl = this.sessionCacheConfig.getTTL(dataType);
    if (ttl <= 0) {
      return;
    }

    this.cache.set(key, data);
    this.cacheExpiry.set(key, Date.now() + ttl);
    
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
    const requestPromise = this.fetchServicesFromAPI(categoryId, forceRefresh);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      
      // Only cache if we got valid data
      if (result && Array.isArray(result) && result.length >= 0) {
        this.setCachedData(cacheKey, result);
      } else {
      }
      
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch services from API with cache-first loading
  async fetchServicesFromAPI(categoryId, forceRefresh = false) {
    
    try {
      // Always try backend cache first (unless force refresh)
      if (!forceRefresh) {
        try {
          const cachedResponse = await axios.get(`/api/services/categories/${categoryId}?cached_only=true`);
          
          if (cachedResponse.data.success && cachedResponse.data.cached) {
            const cachedServices = cachedResponse.data.services || [];
            
            // Only return cached services if there are actually services in the cache
            if (cachedServices.length > 0) {
              return cachedServices;
            } else {
            }
          }
        } catch (cacheError) {
        }
      } else {
      }

      // If no cached data or force refresh, fetch from API
      const response = await axios.get(`/api/gmb/categories/batchGet`, {
        params: {
          names: categoryId,
          regionCode: 'US',
          languageCode: 'en',
          view: 'FULL'
        }
      });
      
      
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
    const requestPromise = this.fetchExistingServicesFromAPI(locationId, forceRefresh);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      
      // Only cache if we got valid data
      if (result && Array.isArray(result) && result.length >= 0) {
        this.setCachedData(cacheKey, result);
      } else {
      }
      
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch existing services from API with cache-first loading
  async fetchExistingServicesFromAPI(locationId, forceRefresh = false) {
    
    try {
      // Always try backend cache first (unless force refresh)
      if (!forceRefresh) {
        try {
          const cachedResponse = await axios.get(`/api/gmb/locations/${locationId}/services?cached_only=true`);
          
          if (cachedResponse.data.success && cachedResponse.data.cached) {
            const cachedServices = cachedResponse.data.serviceItems || [];
            
            // Only return cached services if there are actually services in the cache
            if (cachedServices.length > 0) {
              return cachedServices;
            } else {
            }
          }
        } catch (cacheError) {
        }
      } else {
      }

      // If no cached data or force refresh, fetch from API
      const response = await axios.get(`/api/gmb/locations/${locationId}/services`);
      
      return response.data.serviceItems || [];
    } catch (error) {
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
