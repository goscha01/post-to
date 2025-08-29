# Social Media Integration Backend

This backend provides comprehensive social media integration capabilities, allowing users to connect multiple social media accounts, post articles, schedule content, and fetch analytics across various platforms.

## Supported Platforms

- **Facebook** - Post status updates, photos, and videos
- **Twitter** - Tweet text and media content
- **LinkedIn** - Share professional content and articles
- **Instagram** - Post photos and stories
- **Pinterest** - Pin images and content
- **YouTube** - Upload videos and manage channel content
- **TikTok** - Upload short-form videos

## Features

### Core Functionality
- **Account Management** - Connect and manage multiple social media accounts
- **Content Publishing** - Post articles and media to multiple platforms simultaneously
- **Scheduling** - Schedule posts for optimal timing
- **Analytics** - Track engagement and performance metrics
- **Content Templates** - Save and reuse content templates
- **Campaign Management** - Organize posts into marketing campaigns

### Advanced Features
- **Multi-platform Posting** - Post to multiple platforms with one request
- **Media Support** - Handle images, videos, and other media types
- **Token Management** - Automatic token refresh and error handling
- **Rate Limiting** - Built-in rate limiting to respect API limits
- **Error Handling** - Comprehensive error handling and logging

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and fill in your API credentials:

```bash
cp .env.example .env
```

Required environment variables:
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` for database
- Platform-specific API keys (Facebook, Twitter, LinkedIn, etc.)
- JWT configuration for authentication

### 3. Database Setup

Run the social media schema in your Supabase database:

```sql
-- Execute the contents of supabase/social-media-schema.sql
```

### 4. API Keys Setup

#### Facebook
1. Create a Facebook App at [developers.facebook.com](https://developers.facebook.com)
2. Get App ID and App Secret
3. Generate Access Token with required permissions

#### Twitter
1. Create a Twitter App at [developer.twitter.com](https://developer.twitter.com)
2. Get API Key and API Secret
3. Generate Access Token and Access Token Secret

#### LinkedIn
1. Create a LinkedIn App at [developer.linkedin.com](https://developer.linkedin.com)
2. Get Client ID and Client Secret
3. Generate Access Token with required scopes

#### Other Platforms
Follow similar steps for Instagram, Pinterest, YouTube, and TikTok.

## API Endpoints

### Authentication
All endpoints require authentication via JWT token in the Authorization header.

### Social Media Accounts

#### GET /api/social-media/accounts
Get user's connected social media accounts.

#### POST /api/social-media/connect
Connect a new social media account.

**Request Body:**
```json
{
  "platform": "facebook",
  "accessToken": "your_access_token",
  "refreshToken": "your_refresh_token",
  "platformUserId": "platform_user_id"
}
```

### Content Publishing

#### POST /api/social-media/post
Post content to social media platforms.

**Request Body:**
```json
{
  "platforms": ["facebook", "twitter", "linkedin"],
  "content": "Your article content here",
  "media": ["https://example.com/image.jpg"],
  "scheduledTime": null
}
```

#### POST /api/social-media/schedule
Schedule a post for later.

**Request Body:**
```json
{
  "platforms": ["facebook", "twitter"],
  "content": "Scheduled content",
  "media": [],
  "scheduledTime": "2024-01-15T10:00:00Z"
}
```

### Content Management

#### GET /api/social-media/posts
Get user's posted content.

**Query Parameters:**
- `platform` (optional) - Filter by specific platform
- `limit` (optional) - Number of posts to return (default: 20)
- `offset` (optional) - Pagination offset (default: 0)

#### GET /api/social-media/scheduled
Get user's scheduled posts.

#### DELETE /api/social-media/scheduled/:id
Delete a scheduled post.

### Analytics

#### GET /api/social-media/analytics
Get social media analytics.

**Query Parameters:**
- `platform` (optional) - Filter by specific platform
- `startDate` (optional) - Start date for analytics
- `endDate` (optional) - End date for analytics

### Token Management

#### POST /api/social-media/refresh-tokens
Refresh expired access tokens for all connected accounts.

## Usage Examples

### Connect Facebook Account

```javascript
const response = await fetch('/api/social-media/connect', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${jwtToken}`
  },
  body: JSON.stringify({
    platform: 'facebook',
    accessToken: 'facebook_access_token',
    platformUserId: 'facebook_user_id'
  })
});
```

### Post to Multiple Platforms

```javascript
const response = await fetch('/api/social-media/post', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${jwtToken}`
  },
  body: JSON.stringify({
    platforms: ['facebook', 'twitter', 'linkedin'],
    content: 'Check out our latest article on social media marketing!',
    media: ['https://example.com/article-image.jpg']
  })
});
```

### Schedule a Post

```javascript
const response = await fetch('/api/social-media/schedule', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${jwtToken}`
  },
  body: JSON.stringify({
    platforms: ['facebook', 'twitter'],
    content: 'Happy Monday! Here are this week\'s top tips.',
    scheduledTime: '2024-01-15T09:00:00Z'
  })
});
```

## Error Handling

The API returns consistent error responses:

```json
{
  "success": false,
  "error": "Error message description"
}
```

Common HTTP status codes:
- `200` - Success
- `400` - Bad Request (validation errors)
- `401` - Unauthorized (invalid/missing token)
- `500` - Internal Server Error

## Rate Limiting

The API includes rate limiting to prevent abuse:
- 100 requests per 15 minutes per IP address
- Platform-specific rate limits are also respected

## Security Features

- **JWT Authentication** - Secure token-based authentication
- **Row Level Security** - Database-level access control
- **Input Validation** - Comprehensive request validation
- **CORS Protection** - Configurable cross-origin restrictions
- **Helmet Security** - Security headers and protection

## Monitoring and Logging

- All API requests are logged
- Error tracking and monitoring
- Scheduled post processing logs
- Token refresh monitoring

## Troubleshooting

### Common Issues

1. **Invalid API Keys** - Ensure all platform API keys are correct and have required permissions
2. **Token Expiration** - Use the refresh endpoint to update expired tokens
3. **Rate Limiting** - Respect platform-specific rate limits
4. **Media Upload Issues** - Check file size and format requirements

### Debug Mode

Enable debug logging by setting `NODE_ENV=development` in your environment variables.

## Contributing

When adding new social media platforms:

1. Add platform to the `platforms` object in `SocialMediaService`
2. Implement platform-specific posting methods
3. Add platform validation in routes
4. Update database schema if needed
5. Add platform to environment variables template

## License

MIT License - see LICENSE file for details.
