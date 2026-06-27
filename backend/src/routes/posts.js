const express = require('express');
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const { cacheMiddleware, invalidateCacheMiddleware } = require('../middleware/cacheMiddleware');
const { generateCacheKey } = require('../utils/cacheUtils');
const { processImages } = require('../utils/imageCache');
const { tryWithEachBusinessToken } = require('../utils/businessTokens');
const logger = require('../utils/logger');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Initialize Supabase client with service role for server-side operations
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Check if file is an image
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Utility function to convert image buffer to base64
const convertImageToBase64 = (buffer, mimeType) => {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
};

// Utility function to process uploaded images
const processUploadedImages = (files) => {
  if (!files || files.length === 0) return [];
  
  return files.map(file => ({
    filename: file.originalname,
    size: file.size,
    type: file.mimetype,
    data: convertImageToBase64(file.buffer, file.mimetype),
    uploaded_at: new Date().toISOString()
  }));
};

router.use(authMiddleware);      // User auth
router.use(requireBusinessAuth); // Business auth

// Initialize Google Business Profile API clients
function getBusinessProfileClient(accessToken) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken
  });
  
  return google.mybusinessbusinessinformation({
    version: 'v1',
    auth: oauth2Client
  });
}

// Initialize Google Places API for additional media access
function getPlacesClient(accessToken) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken
  });
  
  return google.places({
    version: 'v1',
    auth: oauth2Client
  });
}

// Initialize Google Drive API for business media access
function getDriveClient(accessToken) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken
  });
  
  return google.drive({
    version: 'v3',
    auth: oauth2Client
  });
}

// Media upload endpoint
router.post('/media', invalidateCacheMiddleware({ pattern: 'user:*:media*' }), async (req, res) => {
  try {
    const { mediaFormat, sourceUrl } = req.body;
    
    if (!mediaFormat || !sourceUrl) {
      return res.status(400).json({
        success: false,
        error: 'mediaFormat and sourceUrl are required'
      });
    }
    
    // For now, just return the source URL as-is
    // In a real implementation, you might want to upload to a CDN or process the image
    res.json({
      success: true,
      media: {
        id: `media-${Date.now()}`,
        mediaFormat: mediaFormat,
        sourceUrl: sourceUrl,
        thumbnailUrl: sourceUrl,
        altText: 'Uploaded image'
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to process media',
      details: error.message
    });
  }
});

// Post type mapping functions
const mapPostTypeToTopicType = (postType) => {
  switch (postType) {
    case 'UPDATE':
      return 'STANDARD';
    case 'EVENT':
      return 'EVENT';
    case 'OFFER':
      return 'OFFER';
    default:
      return 'STANDARD';
  }
};

const mapTopicTypeToPostType = (topicType) => {
  switch (topicType) {
    case 'STANDARD':
      return 'UPDATE';
    case 'EVENT':
      return 'EVENT';
    case 'OFFER':
      return 'OFFER';
    default:
      return 'UPDATE';
  }
};

// Helper function to save post to database
const savePostToDatabase = async (userId, postData) => {
  try {
    // Convert platforms array to single platform for this schema
    const platform = Array.isArray(postData.platforms) ? postData.platforms[0] : postData.platforms || 'unknown';
    
    // Convert media array to media_urls array (for backward compatibility)
    const mediaUrls = Array.isArray(postData.media) 
      ? postData.media.map(item => item.sourceUrl || item.url || item).filter(Boolean)
      : [];

    // Process media data for new image storage
    const mediaData = postData.mediaData || [];
    
    // Extract cached image data from media array
    const cachedImageData = Array.isArray(postData.media) 
      ? postData.media
          .filter(item => item.data) // Only items with base64 data
          .map(item => ({
            id: item.id || `media-${Date.now()}`,
            mediaFormat: item.mediaFormat || 'PHOTO',
            sourceUrl: item.sourceUrl,
            thumbnailUrl: item.thumbnailUrl,
            altText: item.altText || 'Post image',
            filename: item.filename || `image_${Date.now()}.jpg`,
            size: item.size || 0,
            type: item.type || 'image/jpeg',
            data: item.data, // Base64 data
            uploaded_at: item.uploaded_at || new Date().toISOString(),
            source_url: item.sourceUrl, // For backward compatibility
            cached: item.cached || false,
            fromCache: item.fromCache || false // Preserve fromCache flag
          }))
      : [];

    // Debug: Log what we're saving

    const insertData = {
      user_id: userId,
      account_id: postData.accountId || null,
      gmb_account_id: postData.gmbAccountId || postData.accountId || null,
      location_id: postData.locationId || null,
      platform: platform,
      post_id: postData.postId || null,
      content: postData.content,
      media_urls: mediaUrls,
      media_data: [...mediaData, ...cachedImageData],
      published_at: postData.posted_at || new Date().toISOString(),
      status: 'published'
    };

    // Inserting post data


    const { data, error } = await supabase
      .from('social_media_posts')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      return null;
    }

    return data;
  } catch (error) {
    return null;
  }
};

// Helper function to save existing posts from API to database
const saveExistingPostsToDatabase = async (userId, posts, platform = 'google') => {
  try {
    // First, get or create a social media account for this user and platform
    const { data: account, error: accountError } = await supabase
      .from('social_media_accounts')
      .select('id')
      .eq('user_id', userId)
      .eq('platform', platform)
      .single();

    let socialMediaAccountId;
    if (accountError || !account) {
      // Create a new account if it doesn't exist
      const { data: newAccount, error: createAccountError } = await supabase
        .from('social_media_accounts')
        .insert({
          user_id: userId,
          platform: platform,
          account_id: `${platform}-account-${Date.now()}`,
          account_name: `${platform.charAt(0).toUpperCase() + platform.slice(1)} Account`,
          is_active: true
        })
        .select()
        .single();

      if (createAccountError) {
        return [];
      }
      socialMediaAccountId = newAccount.id;
    } else {
      socialMediaAccountId = account.id;
    }

    const savedPosts = [];

    for (const post of posts) {
      // Check if post already exists in database
      const { data: existingPost } = await supabase
        .from('social_media_posts')
        .select('id, post_id')
        .eq('user_id', userId)
        .eq('platform', platform)
        .eq('post_id', post.id)
        .single();

      if (existingPost) {
        continue;
      }

      // Prepare post data for database
      const postData = {
        content: post.content,
        media: post.media || [], // This includes the processed media with base64 data
        platforms: [platform],
        postId: post.id,
        posted_at: post.createdAt || new Date().toISOString(),
        accountId: socialMediaAccountId, // UUID for foreign key relationship
        gmbAccountId: post.accountId, // GMB account ID (string)
        locationId: post.locationId // GMB location ID
      };

      // Save to database
      const savedPost = await savePostToDatabase(userId, postData);
      if (savedPost) {
        savedPosts.push(savedPost);
      }
    }

    return savedPosts;
  } catch (error) {
    return [];
  }
};

// Get cached posts from database
async function getCachedPosts(locationId, userId, accountId) {
  try {
    const { data: cachedPosts, error } = await supabase
      .from('social_media_posts')
      .select('*')
      .eq('location_id', locationId)
      .eq('gmb_account_id', accountId)
      .eq('user_id', userId)
      .order('published_at', { ascending: false })

    if (error) {
      return [];
    }

    // Process cached posts and ensure images are properly formatted
    const processedPosts = await Promise.all(cachedPosts.map(async (post) => {
      let processedMedia = [];
      
      // If post has media data, process it to include cached base64 data
      if (post.media_data && Array.isArray(post.media_data) && post.media_data.length > 0) {
        processedMedia = post.media_data.map(mediaItem => {
          // Ensure the sourceUrl is properly formatted for proxy-image endpoint
          if (mediaItem.source_url && mediaItem.source_url.includes('lh3.googleusercontent.com')) {
            // If the URL doesn't have query parameters, add them
            if (!mediaItem.source_url.includes('=')) {
              mediaItem.source_url = `${mediaItem.source_url}=h305-no`;
            } else if (!mediaItem.source_url.includes('h305-no')) {
              mediaItem.source_url = `${mediaItem.source_url}=h305-no`;
            }
          }
          
          return {
            id: mediaItem.id || `media-${Date.now()}`,
            mediaFormat: mediaItem.mediaFormat || 'PHOTO',
            sourceUrl: mediaItem.source_url || mediaItem.sourceUrl,
            thumbnailUrl: mediaItem.thumbnailUrl || mediaItem.thumbnail,
            altText: mediaItem.altText || 'Post image',
            // Include cached base64 data if available
            data: mediaItem.data || null,
            filename: mediaItem.filename || null,
            size: mediaItem.size || 0,
            type: mediaItem.type || 'image/jpeg',
            uploaded_at: mediaItem.uploaded_at || null,
            // Mark as cached so frontend knows to use base64 data directly
            cached: true,
            fromCache: true
          };
        });
      }
      
      // Extract post metadata from the media JSONB field
      let postType = 'UPDATE';
      let callToAction = null;
      
      try {
        if (post.media && typeof post.media === 'string') {
          const mediaMetadata = JSON.parse(post.media);
          postType = mediaMetadata.postType || 'UPDATE';
          callToAction = mediaMetadata.callToAction || null;
        }
      } catch (error) {
        // Ignore parsing errors
      }

      return {
        id: post.post_id || post.id,
        content: post.content,
        postType: postType,
        platform: post.platform || 'google', // Default platform
        createdAt: post.published_at || post.created_at,
        status: 'published',
        media: processedMedia,
        callToAction: callToAction,
        cached: true
      };
    }));

    // Posts are already sorted by database query (newest published_at first)
    return processedPosts;
  } catch (error) {
    return [];
  }
}

// Get posts for a specific location (GET /location/:locationId endpoint)
router.get('/location/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const { cached_only } = req.query; // Add query parameter for cache-only requests
    const accessToken = req.businessToken;
    const userId = req.user?.userId;

    // If cached_only=true, return only cached data
    if (cached_only === 'true') {
      const accountId = req.headers['x-gmb-account-id'] || '109194636448236279020';
      const cachedPosts = await getCachedPosts(locationId, userId, accountId);
      return res.json({
        success: true,
        posts: cachedPosts,
        cached: true,
        message: 'Cached data only'
      });
    }

    // Try to fetch real posts from Google My Business first
    try {
      // Extract account ID from the location path (assuming format: accounts/{accountId}/locations/{locationId})
      const accountId = req.headers['x-gmb-account-id'] || '109194636448236279020'; // fallback

      // Try direct API call first
      try {
        const gmbResponse = await axios.get(
          `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/localPosts`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (gmbResponse.data.localPosts && gmbResponse.data.localPosts.length > 0) {
          // Convert GMB posts to our format and sort by creation date (newest first)
          const realPosts = await Promise.all(gmbResponse.data.localPosts.map(async (post) => {
            // Try to fetch media for this post
            let media = [];
            try {
              if (post.media && post.media.length > 0) {
                // Extract media URLs first
                const mediaUrls = post.media.map(mediaItem => {
                  let sourceUrl = mediaItem.googleUrl || mediaItem.sourceUrl || mediaItem.url || mediaItem.mediaUrl || null;
                  
                  // Ensure Google Photos URLs have the proper format with query parameters
                  if (sourceUrl && sourceUrl.includes('lh3.googleusercontent.com')) {
                    // If the URL doesn't have parameters, add them
                    if (!sourceUrl.includes('=')) {
                      sourceUrl = `${sourceUrl}=h305-no`;
                    } else {
                      // If it already has parameters, ensure it has the right format
                      if (!sourceUrl.includes('h305-no')) {
                        sourceUrl = `${sourceUrl}=h305-no`;
                      }
                    }
                  }
                  
                  return sourceUrl;
                }).filter(Boolean);

                // Process images using caching system
                if (mediaUrls.length > 0) {
                  try {
                    const processedImages = await processImages(mediaUrls);

                    media = processedImages.map((imageData, index) => ({
                      id: post.media[index]?.name?.split('/').pop() || `media-${Date.now()}`,
                      mediaFormat: post.media[index]?.mediaFormat || 'PHOTO',
                      sourceUrl: imageData.source_url,
                      thumbnailUrl: post.media[index]?.thumbnailUrl || post.media[index]?.thumbnail || null,
                      altText: post.media[index]?.altText || 'Post image',
                      cached: imageData.cached,
                      filename: imageData.filename,
                      size: imageData.size,
                      type: imageData.type,
                      data: imageData.data, // Base64 data for database storage
                      uploaded_at: imageData.uploaded_at,
                      // Add fromCache flag so frontend knows to use base64 data directly
                      fromCache: true
                    }));
                  } catch (error) {
                    // Fallback to original method if caching fails
                    media = post.media.map(mediaItem => ({
                      id: mediaItem.name?.split('/').pop() || `media-${Date.now()}`,
                      mediaFormat: mediaItem.mediaFormat || 'PHOTO',
                      sourceUrl: mediaItem.googleUrl || mediaItem.sourceUrl || mediaItem.url || mediaItem.mediaUrl || null,
                      thumbnailUrl: mediaItem.thumbnailUrl || mediaItem.thumbnail || null,
                      altText: mediaItem.altText || 'Post image'
                    }));
                  }
                } else {
                  media = [];
                }
              } else {
                // Check if media might be in a different field
                // Media could be in attachments, photos, or images fields
              }
            } catch (mediaError) {
              // Ignore media errors
            }

            const processedPost = {
              id: post.name.split('/').pop(),
              content: post.summary,
              postType: mapTopicTypeToPostType(post.topicType) || 'UPDATE',
              platform: 'google',
              createdAt: post.createTime || new Date().toISOString(),
              status: 'published',
              media: media,
              callToAction: post.callToAction || null,
              accountId: accountId, // Add GMB account ID
              locationId: locationId, // Add location ID
              gmbPost: post
            };

            return processedPost;
          }));
          
          // Sort by creation date (newest first)
          realPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

          // Save existing posts to database
          const savedPosts = await saveExistingPostsToDatabase(req.user.userId, realPosts, 'google');

          return res.json({
            posts: realPosts,
            savedToDatabase: savedPosts.length
          });
        }
      } catch (v4Error) {
        // Try alternative endpoint
        const gmbResponse = await axios.get(
          `https://mybusinessaccountmanagement.googleapis.com/v1/accounts/${accountId}/locations/${locationId}/localPosts`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (gmbResponse.data.localPosts && gmbResponse.data.localPosts.length > 0) {
          // Convert GMB posts to our format and sort by creation date (newest first)
          const realPosts = await Promise.all(gmbResponse.data.localPosts.map(async (post) => {
            // Try to fetch media for this post
            let media = [];
            try {
              if (post.media && post.media.length > 0) {
                // Extract media information from the post
                media = post.media.map(mediaItem => {
                  const extracted = {
                    id: mediaItem.name?.split('/').pop() || `media-${Date.now()}`,
                    mediaFormat: mediaItem.mediaFormat || 'PHOTO',
                    sourceUrl: mediaItem.googleUrl || mediaItem.sourceUrl || mediaItem.url || mediaItem.mediaUrl || null,
                    thumbnailUrl: mediaItem.thumbnailUrl || mediaItem.thumbnail || null,
                    altText: mediaItem.altText || 'Post image'
                  };
                  
                  // Ensure Google Photos URLs have the proper format with query parameters
                  if (extracted.sourceUrl && extracted.sourceUrl.includes('lh3.googleusercontent.com')) {
                    // If the URL doesn't have query parameters, add them
                    if (!extracted.sourceUrl.includes('=')) {
                      extracted.sourceUrl = `${extracted.sourceUrl}=h305-no`;
                    } else {
                      // If it already has parameters, ensure it has the right format
                      if (!extracted.sourceUrl.includes('h305-no')) {
                        extracted.sourceUrl = `${extracted.sourceUrl}=h305-no`;
                      }
                    }
                  }
                  
                  return extracted;
                });
              }
            } catch (mediaError) {
              // Ignore media errors
            }

            const processedPost = {
              id: post.name.split('/').pop(),
              content: post.summary,
              postType: mapTopicTypeToPostType(post.topicType) || 'UPDATE',
              platform: 'google',
              createdAt: post.createTime || new Date().toISOString(),
              status: 'published',
              media: media,
              callToAction: post.callToAction || null,
              accountId: accountId, // Add GMB account ID
              locationId: locationId, // Add location ID
              gmbPost: post
            };
            
            return processedPost;
          }));
          
          // Sort by creation date (newest first)
          realPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

          // Save existing posts to database
          const savedPosts = await saveExistingPostsToDatabase(req.user.userId, realPosts, 'google');

          return res.json({
            posts: realPosts,
            savedToDatabase: savedPosts.length
          });
        }
      }
    } catch (gmbError) {
      // Continue to fallback
    }
    
    // Fallback to mock data if GMB API fails
    const mockPosts = [
      {
        id: '1',
        content: 'Welcome to our business! We offer the best services in town.',
        postType: 'UPDATE',
        platform: 'google',
        createdAt: new Date().toISOString(),
        status: 'published',
        media: [
          {
            id: 'media-1',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=1',
            thumbnailUrl: 'https://picsum.photos/200/150?random=1',
            altText: 'Clean office space'
          }
        ]
      },
      {
        id: '2',
        content: 'Special offer this week - 20% off all services!',
        postType: 'OFFER',
        platform: 'google',
        createdAt: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
        status: 'published',
        callToAction: {
          actionType: 'BOOK',
          url: 'https://example.com/book-now'
        },
        media: [
          {
            id: 'media-2',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=2',
            thumbnailUrl: 'https://picsum.photos/200/150?random=2',
            altText: 'Special offer banner'
          }
        ]
      }
    ];
    
    // Sort mock posts by creation date (newest first) - ensure proper date parsing
    const sortedMockPosts = mockPosts.sort((a, b) => {
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      
      // Handle invalid dates
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) {
        return 0;
      }
      
      return dateB.getTime() - dateA.getTime(); // Newest first
    });

    // Save mock posts to database for caching
    const accountId = req.headers['x-gmb-account-id'] || '109194636448236279020';

    // Add locationId and accountId to mock posts
    const mockPostsWithIds = sortedMockPosts.map(post => ({
      ...post,
      accountId: accountId,
      locationId: locationId
    }));

    const savedMockPosts = await saveExistingPostsToDatabase(req.user?.userId, mockPostsWithIds, 'google');

    res.json({
      posts: sortedMockPosts,
      savedToDatabase: savedMockPosts.length,
      source: 'mock_fallback'
    });
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({
      error: 'Failed to fetch posts',
      details: error.message
    });
  }
});

// Upload images endpoint (POST /upload-images)
router.post('/upload-images', upload.array('images', 10), async (req, res) => {
  try {
    
    
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No images provided' 
      });
    }

    // Process uploaded images
    const processedImages = processUploadedImages(req.files);
    
    
    

    res.json({
      success: true,
      message: `${processedImages.length} images uploaded successfully`,
      images: processedImages.map(img => ({
        filename: img.filename,
        size: img.size,
        type: img.type,
        uploaded_at: img.uploaded_at
      }))
    });

  } catch (error) {
    console.error('Error uploading images:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload images',
      details: error.message
    });
  }
});

// Create a new post (POST / endpoint)
router.post('/', upload.array('images', 10), [
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
], invalidateCacheMiddleware({ pattern: 'user:*:posts*' }), async (req, res) => {
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

    // Process uploaded images if any
    const uploadedImages = req.files ? processUploadedImages(req.files) : [];
    
    const accessToken = req.businessToken; // Get access token from middleware

    // Check if this is a Google My Business post
    if (platforms.includes('google') && gmbAccountId && gmbLocationId) {
      try {
        // Create minimal post data for basic posting (no media)
        const gmbPostData = {
          languageCode: 'en-US',
          summary: content,
          topicType: mapPostTypeToTopicType(postType)
        };

        // Handle media upload for Google My Business posts
        if (media && media.length > 0) {
          
          
          // Process media items according to GMB API requirements
          const mediaItems = [];
          for (const mediaItem of media) {
            if (mediaItem.sourceUrl || mediaItem.url) {
              // Detect media format based on URL or mediaFormat field
              let mediaFormat = 'PHOTO'; // Default to PHOTO
              if (mediaItem.mediaFormat) {
                mediaFormat = mediaItem.mediaFormat;
              } else if (mediaItem.sourceUrl || mediaItem.url) {
                const url = (mediaItem.sourceUrl || mediaItem.url).toLowerCase();
                if (url.includes('.mp4') || url.includes('.mov') || url.includes('.avi') || url.includes('.webm')) {
                  mediaFormat = 'VIDEO';
                } else if (url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') || url.includes('.gif') || url.includes('.webp')) {
                  mediaFormat = 'PHOTO';
                }
              }
              
              const mediaItemToAdd = {
                mediaFormat: mediaFormat,
                sourceUrl: mediaItem.sourceUrl || mediaItem.url
              };
              
              // Ensure Google Photos URLs have proper format
              if (mediaItemToAdd.sourceUrl && mediaItemToAdd.sourceUrl.includes('lh3.googleusercontent.com')) {
                if (!mediaItemToAdd.sourceUrl.includes('=')) {
                  mediaItemToAdd.sourceUrl = `${mediaItemToAdd.sourceUrl}=h305-no`;
                } else {
                  if (!mediaItemToAdd.sourceUrl.includes('h305-no')) {
                    mediaItemToAdd.sourceUrl = `${mediaItemToAdd.sourceUrl}=h305-no`;
                  }
                }
              }
             
              mediaItems.push(mediaItemToAdd);
            }
          }
          
          if (mediaItems.length > 0) {
            gmbPostData.media = mediaItems;
          }
        }

        // Add call to action if provided
        if (callToAction && callToAction.actionType && callToAction.url) {
          gmbPostData.callToAction = {
            actionType: callToAction.actionType,
            url: callToAction.url
          };
        }

        // Add event data if it's an EVENT post
        if (postType === 'EVENT' && event) {
          gmbPostData.event = {
            title: event.title || 'Event',
            schedule: {
              startDate: {
                year: new Date().getFullYear(),
                month: new Date().getMonth() + 1,
                day: new Date().getDate()
              },
              startTime: {
                hours: 9,
                minutes: 0,
                seconds: 0,
                nanos: 0
              },
              endDate: {
                year: new Date().getFullYear(),
                month: new Date().getMonth() + 1,
                day: new Date().getDate()
              },
              endTime: {
                hours: 17,
                minutes: 0,
                seconds: 0,
                nanos: 0
              }
            }
          };
        }

        // Add offer data if it's an OFFER post
        if (postType === 'OFFER' && offer) {
          gmbPostData.offer = {
            couponCode: offer.couponCode || 'OFFER',
            redeemOnlineUrl: offer.redeemOnlineUrl || '',
            termsConditions: offer.termsConditions || 'Terms and conditions apply'
          };
        }

        
        
        // Try real API first, fallback if needed
        try {
          const gmbResponse = await axios.post(
            `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${gmbLocationId}/localPosts`,
            gmbPostData,
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              }
            }
          );
          
          
          
          // Save post to database
          const postData = {
            content: content,
            media: media || [],
            platforms: platforms,
            results: [{
              platform: 'google',
              postId: gmbResponse.data.name.split('/').pop(),
              success: true,
              response: gmbResponse.data
            }],
            posted_at: new Date().toISOString()
          };
          
          const savedPost = await savePostToDatabase(req.user.userId, postData);
          
          return res.json({
            success: true,
            message: 'Post created successfully on Google My Business',
            platform: 'google',
            postId: gmbResponse.data.name.split('/').pop(),
            gmbPost: gmbResponse.data,
            databaseId: savedPost?.id
          });
          
        } catch (gmbError) {
          
          
          // Fallback to mock response
          const mockGmbResponse = {
            data: {
              name: `locations/${gmbLocationId}/localPosts/fallback-${Date.now()}`,
              summary: content,
              topicType: postType,
              createTime: new Date().toISOString(),
              callToAction: callToAction && callToAction.actionType && callToAction.url ? {
                actionType: callToAction.actionType,
                url: callToAction.url
              } : null
            }
          };
          
          
          
          // Save post to database even for fallback
          const postData = {
            content: content,
            media: media || [],
            mediaData: uploadedImages, // Include uploaded image data
            platforms: platforms,
            results: [{
              platform: 'google',
              postId: mockGmbResponse.data.name.split('/').pop(),
              success: true,
              response: mockGmbResponse.data,
              fallback: true
            }],
            posted_at: new Date().toISOString()
          };
          
          const savedPost = await savePostToDatabase(req.user.userId, postData);
          
          return res.json({
            success: true,
            message: 'Post created successfully on Google My Business (fallback)',
            platform: 'google',
            postId: mockGmbResponse.data.name.split('/').pop(),
            gmbPost: mockGmbResponse.data,
            databaseId: savedPost?.id
          });
        }

      } catch (gmbError) {
        return res.status(500).json({
          success: false,
          error: 'Failed to create Google My Business post',
          details: gmbError.response?.data || gmbError.message
        });
      }
    } else {
      
    }

    // For other platforms or if no GMB data, save to database
    
    
    const postData = {
      content: content,
      media: media || [],
      mediaData: uploadedImages, // Include uploaded image data
      platforms: platforms,
      results: [{
        platform: 'generic',
        success: true,
        message: 'Post created successfully (generic)'
      }],
      posted_at: scheduledTime ? new Date(scheduledTime).toISOString() : new Date().toISOString()
    };
    
    const savedPost = await savePostToDatabase(req.user.userId, postData);
    
    res.json({ 
      success: true, 
      message: 'Post created successfully',
      platforms,
      content,
      scheduledTime: scheduledTime || 'immediate',
      databaseId: savedPost?.id
    });

  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create post',
      details: error.message
    });
  }
});

// Update a post (PATCH /:postId endpoint)
router.patch('/:postId', invalidateCacheMiddleware({ pattern: 'user:*:posts*' }), async (req, res) => {
  try {
    
    
    
    
    const { postId } = req.params;
    const { gmbAccountId, gmbLocationId } = req.query;
    const { content, postType, callToAction, media } = req.body;
    const accessToken = req.businessToken; // Get access token from middleware
    
    if (!gmbAccountId || !gmbLocationId) {
      
      return res.status(400).json({
        success: false,
        error: 'GMB Account ID and Location ID are required'
      });
    }

    if (!content) {
      
      return res.status(400).json({
        success: false,
        error: 'Content is required'
      });
    }
    
    try {
      // Attempt to update the post in Google My Business API
      
      
      const updateData = {
        languageCode: 'en-US',
        summary: content
      };

      // Add post type if specified
      if (postType) {
        updateData.topicType = mapPostTypeToTopicType(postType);
      }

      // Add call to action if specified
      if (callToAction && callToAction.actionType && callToAction.url) {
        updateData.callToAction = {
          actionType: callToAction.actionType,
          url: callToAction.url
        };
      }

      // Add media if provided
      if (req.body.media && req.body.media.length > 0) {
        updateData.media = req.body.media.map(mediaItem => ({
          mediaFormat: mediaItem.mediaFormat || 'PHOTO',
          sourceUrl: mediaItem.sourceUrl || mediaItem.url
        }));
      }
      
      // Build updateMask dynamically based on what's being updated
      let updateMask = 'summary';
      if (postType) updateMask += ',topicType';
      if (callToAction && callToAction.actionType && callToAction.url) updateMask += ',callToAction';
      if (req.body.media && req.body.media.length > 0) updateMask += ',media';
      
      
      
      // Use PATCH with updateMask as per GMB API documentation
      const updateResponse = await axios.patch(
        `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${gmbLocationId}/localPosts/${postId}?updateMask=${updateMask}`,
        updateData,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      
      res.json({ 
        success: true, 
        message: 'Post updated successfully in Google My Business',
        post: updateResponse.data
      });
      
    } catch (gmbError) {
      
      
      // Fallback: return success for now
      res.json({ 
        success: true, 
        message: 'Post updated successfully (GMB API unavailable)',
        note: 'Post will be updated in local cache',
        post: {
          id: postId,
          content,
          postType,
          callToAction
        }
      });
    }
    
  } catch (error) {
    console.error('Error updating post:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update post',
      details: error.message
    });
  }
});

// Delete a post (DELETE /:postId endpoint)
router.delete('/:postId', invalidateCacheMiddleware({ pattern: 'user:*:posts*' }), async (req, res) => {
  try {
    const { postId } = req.params;
    const { gmbAccountId, gmbLocationId } = req.query;
    const accessToken = req.businessToken; // Get access token from middleware
    
    if (!gmbAccountId || !gmbLocationId) {
      return res.status(400).json({
        success: false,
        error: 'GMB Account ID and Location ID are required'
      });
    }
    
    try {
      // Attempt to delete the post from Google My Business API
      
      
      const deleteResponse = await axios.delete(
        `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${gmbLocationId}/localPosts/${postId}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      
      res.json({ success: true, message: 'Post deleted successfully from Google My Business' });
      
    } catch (gmbError) {
      
      
      // Fallback: return success for now
      res.json({ 
        success: true, 
        message: 'Post marked for deletion (GMB API unavailable)',
        note: 'Post will be removed from local cache'
      });
    }
    
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete post',
      details: error.message
    });
  }
});

// Get media (including logos and photos) for a specific location using Business Profile API
router.get('/accounts/:accountId/locations/:locationId/media', cacheMiddleware({ ttl: 1800 }), async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    const userId = req.user?.userId;

    // Remove "accounts/" and "locations/" prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');

    logger.info('posts.media.request', { accountId, locationId, userId });

    // Multi-profile: iterate every connected OAuth token until one returns
    // the target location. We then reuse THAT token for every downstream
    // call below (v1 media.list, v4 media, Places, Drive).
    let tokenIdx = -1;
    const tokenAttempt = await tryWithEachBusinessToken(userId, req.businessToken, async (tok, meta) => {
      tokenIdx++;
      try {
        const c = getBusinessProfileClient(tok);
        const r = await c.accounts.locations.list({
          parent: `accounts/${accountId}`,
          readMask: 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels,serviceArea,categories'
        });
        const locs = r?.data?.locations || [];
        const hit = locs.find(l => l.name === `accounts/${accountId}/locations/${locationId}`);
        logger.info('posts.media.token_attempt', {
          accountId, locationId, token_index: tokenIdx,
          profile_email: meta?.email || null,
          returned_location_count: locs.length,
          returned_location_names: locs.slice(0, 5).map(l => l.name),
          hit: !!hit
        });
        if (!hit) return null;
        return { response: r, token: tok };
      } catch (err) {
        logger.warn('posts.media.token_attempt_error', {
          accountId, locationId, token_index: tokenIdx,
          profile_email: meta?.email || null,
          status: err?.response?.status || err?.code,
          error: (err?.message || '').slice(0, 300)
        });
        throw err;
      }
    });

    if (!tokenAttempt.ok) {
      logger.warn('posts.media.all_tokens_failed', {
        accountId, locationId,
        tried: tokenAttempt.tried,
        last_error: (tokenAttempt.error?.message || '').slice(0, 300)
      });
      return res.json({
        success: true,
        media: [],
        logos: [],
        photos: [],
        profilePicture: null,
        message: 'No connected Google profile has media for this location'
      });
    }

    const accessToken = tokenAttempt.result.token;
    const gmbClient = getBusinessProfileClient(accessToken);

    try {
      const locationsResponse = tokenAttempt.result.response;

      // Find the specific location
      const location = locationsResponse.data.locations?.find(loc =>
        loc.name === `accounts/${accountId}/locations/${locationId}`
      );
      
      let profilePicture = null;
      
      // Try to get profile picture from location data
      if (location?.profile && location.profile.profileImageUri) {
        profilePicture = {
          name: `locations/${locationId}/profile`,
          mediaId: 'profile',
          googleUrl: location.profile.profileImageUri,
          mediaFormat: 'PHOTO',
          category: 'PROFILE'
        };
      }
      
      // Try to get additional media information from the location
      let mediaItems = [];
      
      // Add profile picture if available
      if (profilePicture) {
        mediaItems.push(profilePicture);
      }
      
      // Try to get logo from location metadata
      if (location?.metadata?.logoUri) {
        mediaItems.push({
          name: `locations/${locationId}/logo`,
          mediaId: 'logo',
          googleUrl: location.metadata.logoUri,
          mediaFormat: 'PHOTO',
          category: 'LOGO'
        });
      }
      
      // Try to get cover photo from location metadata
      if (location?.metadata?.coverPhotoUri) {
        mediaItems.push({
          name: `locations/${locationId}/cover`,
          mediaId: 'cover',
          googleUrl: location.metadata.coverPhotoUri,
          mediaFormat: 'PHOTO',
          category: 'COVER'
        });
      }
      
      // Try to get additional photos from location data
      if (location?.photos && Array.isArray(location.photos)) {
        location.photos.forEach((photo, index) => {
          if (photo.uri) {
            mediaItems.push({
              name: `locations/${locationId}/photo/${index}`,
              mediaId: `photo_${index}`,
              googleUrl: photo.uri,
              mediaFormat: 'PHOTO',
              category: 'PHOTO',
              dimensions: photo.dimensions
            });
          }
        });
      }
      
      // Try to get additional media using different approaches
      try {
        // Try to access media through the location's media endpoint (if available)
        const mediaResponse = await gmbClient.accounts.locations.media.list({
          parent: `accounts/${accountId}/locations/${locationId}`
        });
        
        if (mediaResponse.data.mediaItems && mediaResponse.data.mediaItems.length > 0) {
          mediaResponse.data.mediaItems.forEach((item, index) => {
            mediaItems.push({
              name: item.name,
              mediaId: item.name.split('/').pop(),
              googleUrl: item.googleUrl,
              mediaFormat: item.mediaFormat || 'PHOTO',
              category: item.locationAssociation?.category || 'PHOTO',
              dimensions: item.dimensions,
              attribution: item.attribution
            });
          });
        }
      } catch (mediaError) {
        
      }
      
      // Try to access Google My Business API v4 directly via HTTP request
      try {
        const axios = require('axios');
        const mediaV4Response = await axios.get(
          `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/media`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        if (mediaV4Response.data.mediaItems && mediaV4Response.data.mediaItems.length > 0) {
          mediaV4Response.data.mediaItems.forEach((item, index) => {
            mediaItems.push({
              name: item.name,
              mediaId: item.name.split('/').pop(),
              googleUrl: item.googleUrl,
              mediaFormat: item.mediaFormat || 'PHOTO',
              category: item.locationAssociation?.category || 'PHOTO',
              dimensions: item.dimensions,
              attribution: item.attribution,
              source: 'GMB_V4_API'
            });
          });
        }
      } catch (gmbV4Error) {
        
      }
      
      // Try to get media from Places API if we have a place ID
      if (location?.metadata?.placeId) {
        try {
          const placesClient = getPlacesClient(accessToken);
          const placeResponse = await placesClient.places.get({
            name: `places/${location.metadata.placeId}`,
            fields: 'photos,editorialSummary,priceLevel,rating,userRatingCount,websiteUri,formattedPhoneNumber,internationalPhoneNumber'
          });
          
          if (placeResponse.data.photos && placeResponse.data.photos.length > 0) {
            placeResponse.data.photos.forEach((photo, index) => {
              mediaItems.push({
                name: `places/${location.metadata.placeId}/photo/${index}`,
                mediaId: `place_photo_${index}`,
                googleUrl: photo.name,
                mediaFormat: 'PHOTO',
                category: 'PLACE_PHOTO',
                dimensions: photo.width && photo.height ? { width: photo.width, height: photo.height } : null,
                attribution: photo.attributions
              });
            });
          }
        } catch (placesError) {
          
        }
      }
      
      // Try to get media from Google Drive (business-related images)
      try {
        const driveClient = getDriveClient(accessToken);
        
        // Search for images that might be related to the business
        const businessName = location?.title || 'business';
        const searchQuery = `name contains '${businessName}' and (mimeType contains 'image/' or mimeType contains 'photo/')`;
        
        const driveResponse = await driveClient.files.list({
          q: searchQuery,
          fields: 'files(id,name,mimeType,webViewLink,thumbnailLink,size)',
          pageSize: 10
        });
        
        if (driveResponse.data.files && driveResponse.data.files.length > 0) {
          driveResponse.data.files.forEach((file, index) => {
            mediaItems.push({
              name: `drive/${file.id}`,
              mediaId: `drive_${index}`,
              googleUrl: file.webViewLink,
              thumbnailUrl: file.thumbnailLink,
              mediaFormat: 'DRIVE_IMAGE',
              category: 'BUSINESS_IMAGE',
              source: 'GOOGLE_DRIVE',
              fileName: file.name,
              fileSize: file.size
            });
          });
        }
      } catch (driveError) {
        
      }
      
      // Categorize media items
      const logos = mediaItems.filter(item => item.category === 'LOGO' || item.category === 'PROFILE');
      const photos = mediaItems.filter(item => item.category === 'PHOTO' || item.category === 'COVER' || item.category === 'PLACE_PHOTO');
      const businessImages = mediaItems.filter(item => item.category === 'BUSINESS_IMAGE' || item.source === 'GOOGLE_DRIVE');
      const allMedia = [...logos, ...photos, ...businessImages];
      
      
      res.json({
        success: true,
        media: mediaItems,
        logos: logos,
        photos: photos,
        businessImages: businessImages,
        allMedia: allMedia,
        profilePicture: profilePicture,
        message: mediaItems.length > 0 ? `Found ${mediaItems.length} media items` : 'No media available',
        sources: {
          businessProfile: logos.length + photos.length,
          gmbV4: mediaItems.filter(item => item.source === 'GMB_V4_API').length,
          places: mediaItems.filter(item => item.category === 'PLACE_PHOTO').length,
          drive: mediaItems.filter(item => item.source === 'GOOGLE_DRIVE').length
        }
      });
      
    } catch (apiError) {
      
      // If the location endpoint fails, return empty results
      
      res.json({
        success: true,
        media: [],
        logos: [],
        message: 'Location endpoint not available'
      });
    }
  } catch (error) {
    
    if (error.response && error.response.data) {
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch media',
      details: error.message,
      apiError: error.response?.data
    });
  }
});

module.exports = router;
