import axios from '../utils/axiosConfig';

class UserProfileService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = new Map();
    this.cacheTTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  }

  // Get cached user profile image data
  getCachedProfileImage(userId) {
    const key = `profile_image_${userId}`;
    const now = Date.now();

    if (this.cache.has(key) && this.cacheExpiry.get(key) > now) {
      return this.cache.get(key);
    }

    // Remove expired cache
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
    }

    return null;
  }

  // Cache user profile image data
  setCachedProfileImage(userId, imageData) {
    const key = `profile_image_${userId}`;
    const expiryTime = Date.now() + this.cacheTTL;

    this.cache.set(key, imageData);
    this.cacheExpiry.set(key, expiryTime);

  }

  // Process and cache user profile picture
  async processUserProfilePicture(user) {
    if (!user || !user.picture_url) {
      return user;
    }

    try {
      // Check if we have cached image data
      const cachedImageData = this.getCachedProfileImage(user.id);
      if (cachedImageData) {
        return {
          ...user,
          cached_picture_data: cachedImageData.data,
          picture_cached: true
        };
      }

      // If no cached data, fetch and cache the image

      // Get the current token from localStorage
      const token = localStorage.getItem('gmb_token');
      if (!token) {
        return user; // Return user without caching if no token
      }

      const response = await axios.get(`/api/gmb/proxy-image?url=${encodeURIComponent(user.picture_url)}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.data.success) {
        const imageData = {
          data: response.data.dataUrl,
          type: response.data.contentType,
          size: response.data.size,
          cached_at: new Date().toISOString()
        };

        // Cache the image data
        this.setCachedProfileImage(user.id, imageData);

        return {
          ...user,
          cached_picture_data: imageData.data,
          picture_cached: true
        };
      }
    } catch (error) {
    }

    // Return original user data if caching fails
    return user;
  }

  // Clear user profile cache
  clearUserProfileCache(userId = null) {
    if (userId) {
      const key = `profile_image_${userId}`;
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
    } else {
      this.cache.clear();
      this.cacheExpiry.clear();
    }
  }

  // Get cache stats
  getCacheStats() {
    const now = Date.now();
    let validEntries = 0;
    let expiredEntries = 0;

    this.cacheExpiry.forEach((expiry) => {
      if (expiry > now) {
        validEntries++;
      } else {
        expiredEntries++;
      }
    });

    return {
      totalEntries: this.cache.size,
      validEntries,
      expiredEntries,
      cacheSize: this.cache.size
    };
  }
}

// Export a singleton instance
const userProfileService = new UserProfileService();
export default userProfileService;