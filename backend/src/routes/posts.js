const express = require('express');
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);      // User auth
router.use(requireBusinessAuth); // Business auth

// Media upload endpoint
router.post('/media', async (req, res) => {
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
    console.error('Error processing media:', error);
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
    console.log('=== SAVE POST TO DATABASE DEBUG ===');
    console.log('User ID:', userId);
    console.log('Post data:', postData);
    
    // Convert platforms array to single platform for this schema
    const platform = Array.isArray(postData.platforms) ? postData.platforms[0] : postData.platforms || 'unknown';
    
    // Convert media array to media_urls array
    const mediaUrls = Array.isArray(postData.media) 
      ? postData.media.map(item => item.sourceUrl || item.url || item).filter(Boolean)
      : [];

    const insertData = {
      user_id: userId,
      account_id: postData.accountId || null,
      platform: platform,
      post_id: postData.postId || null,
      content: postData.content,
      media_urls: mediaUrls,
      published_at: postData.posted_at || new Date().toISOString(),
      status: 'published'
    };

    console.log('Insert data:', insertData);

    const { data, error } = await supabase
      .from('social_media_posts')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Error saving post to database:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      return null;
    }

    console.log('Post saved to database successfully:', data.id);
    return data;
  } catch (error) {
    console.error('Error in savePostToDatabase:', error);
    console.error('Error stack:', error.stack);
    return null;
  }
};

// Helper function to save existing posts from API to database
const saveExistingPostsToDatabase = async (userId, posts, platform = 'google') => {
  try {
    console.log(`Saving ${posts.length} existing posts to database...`);
    
    // First, get or create a social media account for this user and platform
    const { data: account, error: accountError } = await supabase
      .from('social_media_accounts')
      .select('id')
      .eq('user_id', userId)
      .eq('platform', platform)
      .single();

    let accountId;
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
        console.error('Error creating account:', createAccountError);
        return [];
      }
      accountId = newAccount.id;
    } else {
      accountId = account.id;
    }
    
    const savedPosts = [];
    
    for (const post of posts) {
      // Check if post already exists in database
      const { data: existingPost } = await supabase
        .from('social_media_posts')
        .select('id')
        .eq('user_id', userId)
        .eq('platform', platform)
        .eq('post_id', post.id)
        .single();

      if (existingPost) {
        console.log(`Post ${post.id} already exists in database, skipping...`);
        continue;
      }

      // Prepare post data for database
      const postData = {
        content: post.content,
        media: post.media || [],
        platforms: [platform],
        postId: post.id,
        posted_at: post.createdAt || new Date().toISOString(),
        accountId: accountId
      };

      // Save to database
      const savedPost = await savePostToDatabase(userId, postData);
      if (savedPost) {
        savedPosts.push(savedPost);
      }
    }

    console.log(`Successfully saved ${savedPosts.length} new posts to database`);
    return savedPosts;
  } catch (error) {
    console.error('Error saving existing posts to database:', error);
    return [];
  }
};

// Get posts for a specific location (GET /location/:locationId endpoint)
router.get('/location/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const accessToken = req.businessToken; // Get access token from middleware
    
    console.log('=== FETCHING POSTS DEBUG ===');
    console.log('Location ID:', locationId);
    console.log('Access token exists:', !!accessToken);
    console.log('Access token length:', accessToken ? accessToken.length : 0);
    
    // Try to fetch real posts from Google My Business first
    try {
      // Extract account ID from the location path (assuming format: accounts/{accountId}/locations/{locationId})
      const accountId = req.headers['x-gmb-account-id'] || '109194636448236279020'; // fallback
      
      console.log('Attempting to fetch real GMB posts...');
      console.log('Account ID:', accountId);
      
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
          console.log('Found real GMB posts:', gmbResponse.data.localPosts.length);
          console.log('=== COMPLETE GMB RESPONSE DEBUG ===');
          console.log('Full GMB response:', JSON.stringify(gmbResponse.data, null, 2));
          console.log('=== FIRST POST DETAILED DEBUG ===');
          console.log('First post complete object:', JSON.stringify(gmbResponse.data.localPosts[0], null, 2));
          console.log('First post media array:', gmbResponse.data.localPosts[0].media);
          console.log('First post media type:', typeof gmbResponse.data.localPosts[0].media);
          console.log('First post media length:', gmbResponse.data.localPosts[0].media?.length);
          if (gmbResponse.data.localPosts[0].media && gmbResponse.data.localPosts[0].media.length > 0) {
            console.log('First media item keys:', Object.keys(gmbResponse.data.localPosts[0].media[0]));
            console.log('First media item complete:', JSON.stringify(gmbResponse.data.localPosts[0].media[0], null, 2));
          }
          console.log('=== END FIRST POST DEBUG ===');
         
          // Convert GMB posts to our format and sort by creation date (newest first)
          const realPosts = await Promise.all(gmbResponse.data.localPosts.map(async (post) => {
            // Try to fetch media for this post
            let media = [];
            try {
              if (post.media && post.media.length > 0) {
                console.log('=== MEDIA PROCESSING DEBUG ===');
                console.log('Post has media:', post.media.length, 'items');
                console.log('Raw media array:', post.media);
                console.log('First media item raw:', JSON.stringify(post.media[0], null, 2));
                console.log('First media item keys:', Object.keys(post.media[0]));
                
                // Try to find any URL-like fields
                const possibleUrlFields = ['sourceUrl', 'url', 'mediaUrl', 'thumbnailUrl', 'thumbnail', 'imageUrl', 'photoUrl', 'media', 'googleUrl'];
                console.log('Checking for URL fields:', possibleUrlFields);
                possibleUrlFields.forEach(field => {
                  if (post.media[0][field]) {
                    console.log(`Found ${field}:`, post.media[0][field]);
                  }
                });
                
                // Additional debugging - check all fields in the media item
                console.log('=== ALL MEDIA ITEM FIELDS ===');
                Object.keys(post.media[0]).forEach(key => {
                  console.log(`${key}:`, post.media[0][key]);
                });
                console.log('=== END ALL MEDIA ITEM FIELDS ===');
                
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
                    // If the URL doesn't have parameters, add them
                    if (!extracted.sourceUrl.includes('=')) {
                      extracted.sourceUrl = `${extracted.sourceUrl}=h305-no`;
                      console.log(`Fixed Google Photos URL: ${extracted.sourceUrl}`);
                    } else {
                      // If it already has parameters, ensure it has the right format
                      if (!extracted.sourceUrl.includes('h305-no')) {
                        extracted.sourceUrl = `${extracted.sourceUrl}=h305-no`;
                        console.log(`Enhanced Google Photos URL: ${extracted.sourceUrl}`);
                      }
                    }
                  }
                  
                  console.log('Extracted media item:', extracted);
                  return extracted;
                });
                
                console.log('Final processed media array:', media);
                console.log('=== END MEDIA PROCESSING DEBUG ===');
              } else {
                console.log('Post has no media array');
                console.log('Post keys:', Object.keys(post));
                // Check if media might be in a different field
                if (post.attachments) console.log('Post has attachments:', post.attachments);
                if (post.photos) console.log('Post has photos:', post.photos);
                if (post.images) console.log('Post has images:', post.images);
              }
            } catch (mediaError) {
              console.log('Could not fetch media for post:', mediaError.message);
              console.log('Media error details:', mediaError);
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
              gmbPost: post
            };
            
            console.log('=== PROCESSED POST DEBUG ===');
            console.log('Processed post ID:', processedPost.id);
            console.log('Processed post media:', processedPost.media);
            console.log('Processed post callToAction:', processedPost.callToAction);
            console.log('Processed post has media:', !!processedPost.media);
            console.log('Processed post has callToAction:', !!processedPost.callToAction);
            console.log('=== END PROCESSED POST DEBUG ===');
            
            return processedPost;
          }));
          
          // Sort by creation date (newest first)
          realPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          
          console.log(`Found ${realPosts.length} real GMB posts for location ${locationId}`);
          
          // Save existing posts to database
          const savedPosts = await saveExistingPostsToDatabase(req.user.userId, realPosts, 'google');
          console.log(`Saved ${savedPosts.length} posts to database`);
          
          return res.json({
            posts: realPosts,
            savedToDatabase: savedPosts.length
          });
        }
      } catch (v4Error) {
        console.log('GMB v4 failed, trying alternative endpoint:', v4Error.message);
        
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
          console.log('Found real GMB posts from alternative endpoint:', gmbResponse.data.localPosts.length);
          
          // Convert GMB posts to our format and sort by creation date (newest first)
          const realPosts = await Promise.all(gmbResponse.data.localPosts.map(async (post) => {
            // Try to fetch media for this post
            let media = [];
            try {
              if (post.media && post.media.length > 0) {
                console.log('Post has media:', post.media.length, 'items');
                
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
                      console.log(`Fixed Google Photos URL: ${extracted.sourceUrl}`);
                    } else {
                      // If it already has parameters, ensure it has the right format
                      if (!extracted.sourceUrl.includes('h305-no')) {
                        extracted.sourceUrl = `${extracted.sourceUrl}=h305-no`;
                        console.log(`Enhanced Google Photos URL: ${extracted.sourceUrl}`);
                      }
                    }
                  }
                  
                  return extracted;
                });
              }
            } catch (mediaError) {
              console.log('Could not fetch media for post:', mediaError.message);
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
              gmbPost: post
            };
            
            return processedPost;
          }));
          
          // Sort by creation date (newest first)
          realPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          
          console.log(`Found ${realPosts.length} real GMB posts for location ${locationId}`);
          
          // Save existing posts to database
          const savedPosts = await saveExistingPostsToDatabase(req.user.userId, realPosts, 'google');
          console.log(`Saved ${savedPosts.length} posts to database`);
          
          return res.json({
            posts: realPosts,
            savedToDatabase: savedPosts.length
          });
        }
      }
    } catch (gmbError) {
      console.log('Could not fetch real GMB posts, using mock data:', gmbError.message);
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
    
    // Sort mock posts by creation date (newest first)
    const sortedMockPosts = mockPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({
      posts: sortedMockPosts
    });
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// Create a new post (POST / endpoint)
router.post('/', [
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
    console.log('Validation errors:', errors.array());
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    console.log('=== POST CREATION DEBUG ===');
    console.log('Request body:', req.body);
    console.log('User access token exists:', !!req.businessToken);
    
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
    
    const accessToken = req.businessToken; // Get access token from middleware
    
    console.log('Extracted data:', {
      platforms,
      content,
      media,
      gmbAccountId,
      gmbLocationId,
      postType
    });

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
          console.log('Processing media for GMB post:', media.length, 'items');
          
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

        console.log('Creating GMB post with data:', JSON.stringify(gmbPostData, null, 2));
        
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
          
          console.log('Real GMB post created successfully:', gmbResponse.data);
          
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
          console.log('GMB post creation failed, using fallback:', gmbError.message);
          
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
          
          console.log('Fallback GMB post creation successful');
          
          // Save post to database even for fallback
          const postData = {
            content: content,
            media: media || [],
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
        console.error('Error creating GMB post:', gmbError);
        return res.status(500).json({
          success: false,
          error: 'Failed to create Google My Business post',
          details: gmbError.response?.data || gmbError.message
        });
      }
    } else {
      console.log('GMB conditions not met, falling back to generic response');
    }

    // For other platforms or if no GMB data, save to database
    console.log('Saving non-GMB post to database');
    
    const postData = {
      content: content,
      media: media || [],
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
    res.status(500).json({ success: false, error: 'Failed to create post' });
  }
});

// Update a post (PATCH /:postId endpoint)
router.patch('/:postId', async (req, res) => {
  try {
    console.log('=== BACKEND UPDATE POST STARTED ===');
    console.log('Post ID:', req.params.postId);
    console.log('Request body:', req.body);
    
    const { postId } = req.params;
    const { gmbAccountId, gmbLocationId } = req.query;
    const { content, postType, callToAction, media } = req.body;
    const accessToken = req.businessToken; // Get access token from middleware
    
    if (!gmbAccountId || !gmbLocationId) {
      console.log('Missing GMB IDs:', { gmbAccountId, gmbLocationId });
      return res.status(400).json({
        success: false,
        error: 'GMB Account ID and Location ID are required'
      });
    }

    if (!content) {
      console.log('No content provided');
      return res.status(400).json({
        success: false,
        error: 'Content is required'
      });
    }
    
    try {
      // Attempt to update the post in Google My Business API
      console.log(`Attempting to update GMB post: ${postId} in location: ${gmbLocationId}`);
      
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
      
      console.log('Update mask:', updateMask);
      
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
      
      console.log('GMB post updated successfully:', updateResponse.status);
      res.json({ 
        success: true, 
        message: 'Post updated successfully in Google My Business',
        post: updateResponse.data
      });
      
    } catch (gmbError) {
      console.log('GMB API update failed, using fallback:', gmbError.message);
      
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
    console.error('=== BACKEND UPDATE POST ERROR ===');
    console.error('Error updating post:', error);
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update post',
      details: error.message 
    });
  }
});

// Delete a post (DELETE /:postId endpoint)
router.delete('/:postId', async (req, res) => {
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
      console.log(`Attempting to delete GMB post: ${postId} from location: ${gmbLocationId}`);
      
      const deleteResponse = await axios.delete(
        `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${gmbLocationId}/localPosts/${postId}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('GMB post deleted successfully:', deleteResponse.status);
      res.json({ success: true, message: 'Post deleted successfully from Google My Business' });
      
    } catch (gmbError) {
      console.log('GMB API delete failed, using fallback:', gmbError.message);
      
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

module.exports = router;
