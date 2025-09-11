# Caching Service

A comprehensive caching service for the Google My Business API application that provides both in-memory and persistent caching capabilities.

## Features

- **In-Memory Caching**: Fast access to frequently used data
- **Persistent Caching**: Data stored in Supabase database for durability
- **Automatic Expiration**: TTL-based cache invalidation
- **Smart TTL**: Different cache durations based on data type
- **Cache Statistics**: Monitor cache performance and usage
- **User-Specific Caching**: Isolated cache per user
- **Automatic Cleanup**: Background processes clean expired entries

## Files Structure

```
backend/src/
├── services/
│   ├── cacheService.js          # Main caching service
│   └── README.md               # This documentation
├── middleware/
│   └── cacheMiddleware.js       # Express middleware for caching
├── utils/
│   └── cacheUtils.js           # Utility functions for common operations
└── routes/
    └── cache.js                # Cache management endpoints
```

## Database Schema

The caching service uses a `cache_data` table in Supabase:

```sql
CREATE TABLE cache_data (
  id BIGSERIAL PRIMARY KEY,
  cache_key VARCHAR(500) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Usage Examples

### Basic Caching

```javascript
const cacheService = require('./services/cacheService');

// Cache data
cacheService.setMemoryCache('user:123', userData, 300000); // 5 minutes

// Retrieve data
const cachedData = cacheService.getMemoryCache('user:123');
```

### API Response Caching

```javascript
const cacheService = require('./services/cacheService');

// Cache API response
cacheService.cacheApiResponse('gmb/accounts', {}, accountsData, userId, 600000);

// Retrieve cached response
const cachedResponse = cacheService.getCachedApiResponse('gmb/accounts', {}, userId);
```

### Using Cache Utils

```javascript
const CacheUtils = require('./utils/cacheUtils');

// Cache GMB accounts
CacheUtils.cacheGmbAccounts(userId, accountsData);

// Get cached accounts
const cachedAccounts = CacheUtils.getCachedGmbAccounts(userId);

// Invalidate cache
CacheUtils.invalidateGmbCache(userId, 'accounts');
```

### Using Cache Middleware

```javascript
const { cacheMiddleware } = require('./middleware/cacheMiddleware');

// Apply caching to route
router.get('/accounts', cacheMiddleware({ ttl: 600000 }), getAccountsHandler);

// Apply cache invalidation
router.post('/accounts', invalidateCacheMiddleware('gmb/accounts*'), createAccountHandler);
```

## Cache TTL (Time To Live)

Different data types have different default TTL values:

- **Account Data**: 30 minutes
- **Media Data**: 1 hour
- **Posts Data**: 2 minutes (more dynamic)
- **Reviews Data**: 15 minutes
- **Default**: 5 minutes

## Cache Endpoints

### GET /api/cache/stats
Get cache statistics and health information.

### POST /api/cache/clear
Clear cache for current user.
```json
{
  "type": "memory|persistent|all",
  "pattern": "gmb/accounts*"
}
```

### GET /api/cache/health
Get cache health status.

### POST /api/cache/invalidate
Invalidate specific cache patterns.
```json
{
  "pattern": "gmb/accounts*",
  "type": "accounts"
}
```

### GET /api/cache/test
Test cache functionality.

## Integration Steps

1. **Setup Database**: Run the SQL schema in `supabase/cache-schema.sql`
2. **Import Service**: `const cacheService = require('./services/cacheService');`
3. **Apply Middleware**: Add cache middleware to routes
4. **Use Utils**: Use CacheUtils for common operations
5. **Monitor**: Use cache endpoints to monitor performance

## Next Steps

The next step is to integrate caching with the posts endpoint to cache GMB posts data and test the functionality.

## Performance Benefits

- **Reduced API Calls**: Cached responses reduce external API requests
- **Faster Response Times**: In-memory cache provides sub-millisecond access
- **Better User Experience**: Faster loading of business profiles and data
- **Cost Savings**: Reduced Google API usage costs
- **Reliability**: Fallback to cached data when APIs are unavailable
