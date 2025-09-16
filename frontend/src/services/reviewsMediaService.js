import imageService from './imageService';

class ReviewsMediaService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
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

  // Set cached image with expiry
  setCachedImage(url, dataUrl) {
    this.cache.set(url, dataUrl);
    this.cacheExpiry.set(url, Date.now() + this.cacheTimeout);
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
          console.error('Error fetching profile image:', error);
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
