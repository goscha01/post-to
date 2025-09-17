import axios from '../utils/axiosConfig';
import apiTracker from '../utils/apiTracker';

class PostsService {
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
      if (key.startsWith('posts_')) dataType = 'posts';
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
      if (key.startsWith('posts_')) dataType = 'posts';
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

    // Handle arrays (posts, media)
    if (Array.isArray(data)) {
      return this.validateAndCleanArrayData(data, dataType);
    }

    // Handle objects (single items or response objects)
    if (typeof data === 'object') {
      return this.validateAndCleanObjectData(data, dataType);
    }

    return data;
  }

  // Validate and clean array data (posts, media)
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
    if (dataType === 'posts_response' && data.posts) {
      return {
        ...data,
        posts: this.validateAndCleanArrayData(data.posts, 'posts')
      };
    }

    return data;
  }

  // Clean individual items based on type
  validateAndCleanItem(item, dataType) {
    switch (dataType) {
      case 'posts':
        return this.cleanPostItem(item);
      case 'media':
        return this.cleanMediaItem(item);
      default:
        return item;
    }
  }

  // Clean post items
  cleanPostItem(post) {
    if (!post || typeof post !== 'object') return post;

    return {
      ...post,
      // Ensure required fields exist
      id: post.id || post.post_id || 'unknown',
      content: post.content || post.summary || '',
      postType: post.postType || post.post_type || 'UPDATE',
      platform: post.platform || 'google',
      createdAt: post.createdAt || post.created_at || new Date().toISOString(),
      status: post.status || 'published',
      media: Array.isArray(post.media) ? post.media : [],
      callToAction: post.callToAction || post.call_to_action || null
    };
  }

  // Clean media items
  cleanMediaItem(media) {
    if (!media || typeof media !== 'object') return media;

    return {
      ...media,
      // Ensure required fields exist
      sourceUrl: media.sourceUrl || media.googleUrl || media.url || '',
      altText: media.altText || media.alt_text || 'Post image',
      mediaFormat: media.mediaFormat || media.media_format || 'PHOTO',
      category: media.category || 'PHOTO'
    };
  }

  // Check if item is valid
  isValidItem(item, dataType) {
    if (!item || typeof item !== 'object') return false;

    switch (dataType) {
      case 'posts':
        return !!(item.id || item.post_id) && !!(item.content || item.summary);
      case 'media':
        return !!(item.sourceUrl || item.googleUrl || item.url);
      default:
        return true;
    }
  }

  // Get unique identifier for deduplication
  getItemIdentifier(item, dataType) {
    switch (dataType) {
      case 'posts':
        return item.id || item.post_id || `${item.content?.substring(0, 50)}-${item.createdAt}`;
      case 'media':
        return item.sourceUrl || item.googleUrl || item.url || item.name;
      default:
        return item.id || item.name || JSON.stringify(item);
    }
  }

  // Fetch posts for a specific location with caching
  async getPostsForLocation(locationId, accountId, forceRefresh = false) {
    const cacheKey = `posts_${locationId}`;
    
    // Skip frontend cache - always use backend cache for consistency
    if (forceRefresh) {
      console.log(`🔄 [DEBUG] Force refresh requested, clearing cache for ${cacheKey}`);
      this.cache.delete(cacheKey);
      this.cacheExpiry.delete(cacheKey);
    }

    // Check if request is already in progress
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ [DEBUG] Request already in progress for ${cacheKey}`);
      return this.pendingRequests.get(cacheKey);
    }

    // Create new request
    const requestPromise = this.fetchPostsFromAPI(locationId, accountId, forceRefresh);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      
      // Only cache if we got valid data
      if (result && Array.isArray(result) && result.length >= 0) {
        console.log(`💾 [CACHE] Storing ${result.length} posts in FRONTEND cache for ${locationId}`);
        this.setCachedData(cacheKey, result);
      } else {
        console.log(`⚠️ [CACHE] Not caching invalid data for ${locationId}`);
      }
      
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Fetch posts from API with cache-first loading
  async fetchPostsFromAPI(locationId, accountId, forceRefresh = false) {
    console.log(`🔍 [DEBUG] fetchPostsFromAPI called for locationId: ${locationId}, accountId: ${accountId}, forceRefresh: ${forceRefresh}`);
    
    try {
      // Always try backend cache first (unless force refresh)
      if (!forceRefresh) {
        try {
          console.log(`📦 [CACHE] Fetching from backend cache: /api/posts/location/${locationId}?cached_only=true`);
          const cachedResponse = await axios.get(`/api/posts/location/${locationId}?cached_only=true`, {
            headers: {
              'x-gmb-account-id': accountId
            }
          });
          
          if (cachedResponse.data.success && cachedResponse.data.cached) {
            const cachedPosts = cachedResponse.data.posts || [];
            console.log(`📦 [CACHE] Successfully fetched ${cachedPosts.length} posts from BACKEND cache`);
            
            // Only return cached posts if there are actually posts in the cache
            if (cachedPosts.length > 0) {
              return cachedPosts;
            } else {
              console.log(`📦 [CACHE] Backend cache is empty, will fetch from GMB API`);
            }
          }
        } catch (cacheError) {
          console.log(`💾 [DEBUG] Backend cache not available for location ${locationId}, will fetch from API. Error:`, {
            message: cacheError.message,
            status: cacheError.response?.status,
            statusText: cacheError.response?.statusText,
            data: cacheError.response?.data
          });
        }
      } else {
        console.log(`🔄 [DEBUG] Force refresh requested, skipping backend cache`);
      }

      // If no cached data or force refresh, fetch from API
      console.log(`🌐 [API] Fetching posts from GMB API: /api/posts/location/${locationId}`);
      const response = await axios.get(`/api/posts/location/${locationId}`, {
        headers: {
          'x-gmb-account-id': accountId
        }
      });
      
      console.log(`🌐 [API] Successfully fetched ${response.data.posts?.length || 0} posts from GMB API`);
      return response.data.posts || [];
    } catch (error) {
      console.error(`❌ [DEBUG] Error fetching posts for location ${locationId}:`, error);
      console.error(`❌ [DEBUG] Error details:`, {
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

  // Fetch media for posts with caching
  async getMediaForPosts(posts, forceRefresh = false) {
    if (!posts || posts.length === 0) return posts;


    const postsWithMedia = await Promise.all(
      posts.map(async (post) => {
        if (!post.media || post.media.length === 0) {
          return post;
        }

        // Process media URLs to ensure they work properly while preserving all data
        const processedMedia = post.media.map(mediaItem => {
          // Create a copy to avoid mutating the original
          const processedItem = { ...mediaItem };
          
          if (processedItem.sourceUrl && processedItem.sourceUrl.includes('lh3.googleusercontent.com')) {
            // Ensure Google Photos URLs have the proper format with query parameters
            if (!processedItem.sourceUrl.includes('=')) {
              processedItem.sourceUrl = `${processedItem.sourceUrl}=h305-no`;
            } else if (!processedItem.sourceUrl.includes('h305-no')) {
              processedItem.sourceUrl = `${processedItem.sourceUrl}=h305-no`;
            }
          }
          
          // Preserve all important fields including fromCache and base64 data
          return processedItem;
        });

        return {
          ...post,
          media: processedMedia
        };
      })
    );


    return postsWithMedia;
  }

  // Clear all cache
  clearCache() {
    console.log(`🧹 [DEBUG] Clearing all cache (${this.cache.size} entries)`);
    this.cache.clear();
    this.cacheExpiry.clear();
    this.pendingRequests.clear();
  }

  // Clear posts cache specifically
  clearPostsCache() {
    console.log(`🧹 [DEBUG] Clearing posts cache`);
    const postsKeys = Array.from(this.cache.keys()).filter(key => key.startsWith('posts_'));
    postsKeys.forEach(key => {
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
      console.log(`🗑️ [DEBUG] Cleared cache entry: ${key}`);
    });
    console.log(`🧹 [DEBUG] Cleared ${postsKeys.length} posts cache entries`);
  }

  // Clear media cache specifically
  clearMediaCache() {
    console.log(`🧹 [DEBUG] Clearing media cache`);
    const mediaKeys = Array.from(this.cache.keys()).filter(key => key.startsWith('media_'));
    mediaKeys.forEach(key => {
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
      console.log(`🗑️ [DEBUG] Cleared cache entry: ${key}`);
    });
    console.log(`🧹 [DEBUG] Cleared ${mediaKeys.length} media cache entries`);
  }

  // Force refresh posts for all locations
  async refreshAllPosts(locations) {
    console.log(`🔄 [DEBUG] Force refreshing posts for ${locations.length} locations`);
    
    // Clear posts cache first
    this.clearPostsCache();
    
    // Refresh posts for each location
    const refreshPromises = locations.map(async (location) => {
      try {
        const locationId = location.name.split('/').pop();
        const accountId = location.accountId;
        
        console.log(`🔄 [DEBUG] Refreshing posts for location ${locationId} (account ${accountId})`);
        return await this.getPostsForLocation(locationId, accountId, true);
      } catch (error) {
        console.error(`❌ [DEBUG] Error refreshing posts for location ${location.name}:`, error);
        return null;
      }
    });
    
    const results = await Promise.all(refreshPromises);
    console.log(`🔄 [DEBUG] Completed refresh for ${results.filter(r => r).length} locations`);
    return results;
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
const postsService = new PostsService();

// Expose API tracker globally for debugging
if (typeof window !== 'undefined') {
  window.postsService = postsService;
}

export default postsService;
