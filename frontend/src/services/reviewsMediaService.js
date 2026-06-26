import imageService from './imageService';
import sessionCacheConfig from '../config/sessionCacheConfig';

class ReviewsMediaService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = new Map();
    // Use session-based TTL instead of fixed timeout
    this.sessionCacheConfig = sessionCacheConfig;
  }

  // Get cached image or fetch if expired
  getCachedImage(url) {
    const expiry = this.cacheExpiry.get(url);
    if (!expiry || Date.now() > expiry) {
      this.cache.delete(url);
      this.cacheExpiry.delete(url);
      return null;
    }
    return this.cache.get(url);
  }

  // Set cached image with session-based expiry
  setCachedImage(url, dataUrl) {
    // Check if we should use cache based on session
    if (!this.sessionCacheConfig.shouldUseCache('reviews')) {
      return;
    }

    // Get session-based TTL
    const ttl = this.sessionCacheConfig.getTTL('reviews');
    if (ttl <= 0) {
      return;
    }

    this.cache.set(url, dataUrl);
    this.cacheExpiry.set(url, Date.now() + ttl);
    
  }

  // Process media for reviews (profile images)
  async getMediaForReviews(reviews) {
    if (!reviews || reviews.length === 0) return reviews;

    const reviewsWithMedia = await Promise.all(
      reviews.map(async (review) => {
        if (!review.reviewer?.profilePhotoUrl) {
          return review;
        }

        // Check cache first
        const cachedImage = this.getCachedImage(review.reviewer.profilePhotoUrl);
        if (cachedImage) {
          return {
            ...review,
            reviewer: {
              ...review.reviewer,
              cachedImageUrl: cachedImage
            }
          };
        }

        // Fetch image if not cached
        try {
          const result = await imageService.getImage(review.reviewer.profilePhotoUrl);
          if (result.success) {
            // Cache the result
            this.setCachedImage(review.reviewer.profilePhotoUrl, result.dataUrl);
            return {
              ...review,
              reviewer: {
                ...review.reviewer,
                cachedImageUrl: result.dataUrl
              }
            };
          }
        } catch (error) {
        }

        return review;
      })
    );

    return reviewsWithMedia;
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

export default new ReviewsMediaService();
