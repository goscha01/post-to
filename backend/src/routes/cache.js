const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { cacheStatsMiddleware, clearCacheMiddleware } = require('../middleware/cacheMiddleware');
const CacheUtils = require('../utils/cacheUtils');
const router = express.Router();

// Apply auth middleware to all cache routes
router.use(authMiddleware);

/**
 * GET /api/cache/stats
 * Get cache statistics
 */
router.get('/stats', cacheStatsMiddleware);

/**
 * POST /api/cache/clear
 * Clear cache for current user
 * Body: { type: 'memory'|'persistent'|'all', pattern: 'string' }
 */
router.post('/clear', clearCacheMiddleware);

/**
 * GET /api/cache/health
 * Get cache health status
 */
router.get('/health', async (req, res) => {
  try {
    const stats = CacheUtils.getCacheStats();
    res.json({
      success: true,
      health: {
        status: 'healthy',
        memoryCache: stats,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get cache health'
    });
  }
});

/**
 * POST /api/cache/invalidate
 * Invalidate specific cache patterns
 * Body: { pattern: 'string', type: 'string' }
 */
router.post('/invalidate', async (req, res) => {
  try {
    const { pattern = '*', type = 'all' } = req.body;
    const userId = req.user.userId;
    
    const invalidated = CacheUtils.invalidateGmbCache(userId, type);
    
    res.json({
      success: true,
      message: `Invalidated ${invalidated} cache entries`,
      pattern,
      type,
      invalidated
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to invalidate cache'
    });
  }
});

/**
 * GET /api/cache/test
 * Test cache functionality
 */
router.get('/test', async (req, res) => {
  try {
    const userId = req.user.userId;
    const testData = {
      message: 'This is test cache data',
      timestamp: new Date().toISOString(),
      userId
    };

    // Test memory cache
    CacheUtils.cacheBusinessProfile(userId, 'test-account', testData, 60000); // 1 minute TTL
    
    // Retrieve from cache
    const cachedData = CacheUtils.getCachedBusinessProfile(userId, 'test-account');
    
    res.json({
      success: true,
      message: 'Cache test completed',
      testData,
      cachedData,
      cacheWorking: !!cachedData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Cache test failed'
    });
  }
});

module.exports = router;
