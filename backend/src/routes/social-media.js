const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const auth = require('../middleware/authMiddleware');
const SocialMediaService = require('../services/SocialMediaService');

// Initialize social media service
const socialMediaService = new SocialMediaService();

// Get social media accounts for user
router.get('/accounts', auth, async (req, res) => {
  try {
    const accounts = await socialMediaService.getUserAccounts(req.user.id);
    res.json({ success: true, accounts });
  } catch (error) {
    console.error('Error fetching social media accounts:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch accounts' });
  }
});

// Connect social media account
router.post('/connect', auth, [
  body('platform').isIn(['facebook', 'twitter', 'linkedin', 'instagram', 'pinterest', 'youtube', 'tiktok', 'google']),
  body('accessToken').notEmpty(),
  body('refreshToken').optional(),
  body('platformUserId').notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { platform, accessToken, refreshToken, platformUserId } = req.body;
    const result = await socialMediaService.connectAccount(
      req.user.id,
      platform,
      accessToken,
      refreshToken,
      platformUserId
    );
    res.json({ success: true, account: result });
  } catch (error) {
    console.error('Error connecting social media account:', error);
    res.status(500).json({ success: false, error: 'Failed to connect account' });
  }
});

// Post article to social media
router.post('/post', auth, [
  body('platforms').isArray({ min: 1 }),
  body('content').notEmpty(),
  body('media').optional().isArray(),
  body('scheduledTime').optional().isISO8601()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { platforms, content, media, scheduledTime } = req.body;
    const result = await socialMediaService.postArticle(
      req.user.id,
      platforms,
      content,
      media,
      scheduledTime
    );
    res.json({ success: true, posts: result });
  } catch (error) {
    console.error('Error posting article:', error);
    res.status(500).json({ success: false, error: 'Failed to post article' });
  }
});

// Get posts from social media
router.get('/posts', auth, [
  body('platform').optional().isIn(['facebook', 'twitter', 'linkedin', 'instagram', 'pinterest', 'youtube', 'tiktok', 'google']),
  body('limit').optional().isInt({ min: 1, max: 100 }),
  body('offset').optional().isInt({ min: 0 })
], async (req, res) => {
  try {
    const { platform, limit = 20, offset = 0 } = req.query;
    const posts = await socialMediaService.getPosts(req.user.id, platform, limit, offset);
    res.json({ success: true, posts });
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch posts' });
  }
});

// Create a new post (POST /posts endpoint) - Enhanced to handle GMB
router.post('/posts', auth, [
  body('platforms').isArray({ min: 1 }),
  body('content').notEmpty(),
  body('media').optional().isArray(),
  body('scheduledTime').optional().isISO8601(),
  body('gmbAccountId').optional(),
  body('gmbLocationId').optional(),
  body('postType').optional().isIn(['UPDATE', 'EVENT', 'OFFER']),
  body('event').optional(),
  body('callToAction').optional(),
  body('offer').optional()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { 
      platforms, 
      content, 
      media, 
      scheduledTime,
      gmbAccountId,
      gmbLocationId,
      postType = 'UPDATE',
      event,
      callToAction,
      offer
    } = req.body;
    
    // Check if this is a Google My Business post
    if (platforms.includes('google') && gmbAccountId && gmbLocationId) {
      try {
        // Create GMB post using the GMB API
        const { google } = require('googleapis');
        
        // Initialize Google My Business API v4
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({
          access_token: req.user.accessToken
        });
        
        const gmbV4Client = google.mybusiness({
          version: 'v4',
          auth: oauth2Client
        });
        
        // Prepare GMB post data
        const gmbPostData = {
          languageCode: 'en-US',
          summary: content,
          topicType: postType
        };
        
        // Add event data if it's an event post
        if (event && postType === 'EVENT') {
          gmbPostData.event = event;
        }
        
        // Add call to action if provided
        if (callToAction) {
          gmbPostData.callToAction = callToAction;
        }
        
        // Add offer data if it's an offer post
        if (offer && postType === 'OFFER') {
          gmbPostData.offer = offer;
        }
        
        // Add media if provided
        if (media && media.length > 0) {
          gmbPostData.media = media.map(item => ({
            mediaFormat: item.mediaFormat || 'PHOTO',
            sourceUrl: item.sourceUrl
          }));
        }
        
        console.log('Creating GMB post with data:', JSON.stringify(gmbPostData, null, 2));
        
        // Create the GMB post
        const gmbResponse = await gmbV4Client.accounts.locations.localPosts.create({
          parent: `accounts/${gmbAccountId}/locations/${gmbLocationId}`,
          requestBody: gmbPostData
        });
        
        console.log('GMB post created successfully:', gmbResponse.data);
        
        // Return success for GMB post
        return res.json({
          success: true,
          message: 'Post created successfully on Google My Business',
          platform: 'google',
          postId: gmbResponse.data.name.split('/').pop(),
          gmbPost: gmbResponse.data
        });
        
      } catch (gmbError) {
        console.error('Error creating GMB post:', gmbError);
        return res.status(500).json({
          success: false,
          error: 'Failed to create Google My Business post',
          details: gmbError.message
        });
      }
    }
    
    // For other platforms or if no GMB data, use the existing logic
    if (scheduledTime) {
      // If scheduled time is provided, schedule the post
      const result = await socialMediaService.schedulePost(
        req.user.id,
        platforms,
        content,
        media,
        scheduledTime
      );
      res.json({ success: true, scheduledPost: result, message: 'Post scheduled successfully' });
    } else {
      // If no scheduled time, post immediately
      const result = await socialMediaService.postArticle(
        req.user.id,
        platforms,
        content,
        media
      );
      res.json({ success: true, post: result, message: 'Post created and published successfully' });
    }
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({ success: false, error: 'Failed to create post' });
  }
});

// Get analytics from social media
router.get('/analytics', auth, [
  body('platform').optional().isIn(['facebook', 'twitter', 'linkedin', 'instagram', 'pinterest', 'youtube', 'tiktok', 'google']),
  body('startDate').optional().isISO8601(),
  body('endDate').optional().isISO8601()
], async (req, res) => {
  try {
    const { platform, startDate, endDate } = req.query;
    const analytics = await socialMediaService.getAnalytics(
      req.user.id,
      platform,
      startDate,
      endDate
    );
    res.json({ success: true, analytics });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
});

// Schedule post
router.post('/schedule', auth, [
  body('platforms').isArray({ min: 1 }),
  body('content').notEmpty(),
  body('media').optional().isArray(),
  body('scheduledTime').isISO8601()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { platforms, content, media, scheduledTime } = req.body;
    const result = await socialMediaService.schedulePost(
      req.user.id,
      platforms,
      content,
      media,
      scheduledTime
    );
    res.json({ success: true, scheduledPost: result });
  } catch (error) {
    console.error('Error scheduling post:', error);
    res.status(500).json({ success: false, error: 'Failed to schedule post' });
  }
});

// Get scheduled posts
router.get('/scheduled', auth, async (req, res) => {
  try {
    const scheduledPosts = await socialMediaService.getScheduledPosts(req.user.id);
    res.json({ success: true, scheduledPosts });
  } catch (error) {
    console.error('Error fetching scheduled posts:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch scheduled posts' });
  }
});

// Delete scheduled post
router.delete('/scheduled/:id', auth, async (req, res) => {
  try {
    await socialMediaService.deleteScheduledPost(req.user.id, req.params.id);
    res.json({ success: true, message: 'Scheduled post deleted successfully' });
  } catch (error) {
    console.error('Error deleting scheduled post:', error);
    res.status(500).json({ success: false, error: 'Failed to delete scheduled post' });
  }
});

// Refresh social media tokens
router.post('/refresh-tokens', auth, async (req, res) => {
  try {
    const result = await socialMediaService.refreshTokens(req.user.id);
    res.json({ success: true, refreshedAccounts: result });
  } catch (error) {
    console.error('Error refreshing tokens:', error);
    res.status(500).json({ success: false, error: 'Failed to refresh tokens' });
  }
});

module.exports = router;
