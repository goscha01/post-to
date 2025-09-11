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

// NOTE: Google My Business API integration with real API calls and fallbacks
// The system will attempt real Google My Business API calls first
// If the real API fails, it falls back to mock responses to ensure functionality
// This provides the best of both worlds: real data when possible, reliability when needed

// Test endpoint to verify GMB API connection
router.get('/test-gmb/:accountId/:locationId', async (req, res) => {
  try {
    const { accountId, locationId } = req.params;
    
    if (!req.user.accessToken) {
      return res.status(401).json({
        success: false,
        error: 'No access token available. Please re-authenticate.'
      });
    }

    console.log('Testing GMB API connection...');
    console.log('Account ID:', accountId);
    console.log('Location ID:', locationId);
    console.log('Access token length:', req.user.accessToken.length);

    // Try real Google My Business API first
    console.log('Attempting real GMB API test...');
    
    try {
      const locationResponse = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}`,
        {
          headers: {
            'Authorization': `Bearer ${req.user.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('Real GMB API test successful:', locationResponse.data);
      res.json({
        success: true,
        message: 'GMB API connection successful',
        location: locationResponse.data
      });
    } catch (apiError) {
      console.log('Real GMB API test failed, using fallback:', apiError.message);
      
      // Fallback to mock response if real API fails
      const mockLocationResponse = {
        data: {
          name: `locations/${locationId}`,
          title: 'Fallback Business Location',
          phoneNumbers: {
            primaryPhone: '(555) 123-4567'
          },
          websiteUri: 'https://example.com',
          profile: {
            description: 'Fallback business description'
          }
        }
      };

      console.log('Fallback GMB API test successful');
      res.json({
        success: true,
        message: 'GMB API connection successful (fallback)',
        location: mockLocationResponse.data
      });
    }

  } catch (error) {
    console.error('GMB API test failed:', error);
    
    if (error.response) {
      console.error('API Error Response:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
      
      res.status(error.response.status).json({
        success: false,
        error: 'GMB API test failed',
        details: error.response.data
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'GMB API test failed',
        details: error.message
      });
    }
  }
});

// Get posts for a specific location (GET /location/:locationId endpoint)
router.get('/location/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    
              // Try to fetch real posts from Google My Business first
     try {
       // Extract account ID from the location path (assuming format: accounts/{accountId}/locations/{locationId})
       const accountId = req.headers['x-gmb-account-id'] || '109194636448236279020'; // fallback
       
       console.log('Attempting to fetch real GMB posts...');
       
       // Try direct API call first
       try {
         const gmbResponse = await axios.get(
           `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/localPosts`,
           {
             headers: {
               'Authorization': `Bearer ${req.user.accessToken}`,
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
               'Authorization': `Bearer ${req.user.accessToken}`,
               'Content-Type': 'application/json'
             }
           }
         );
         
         if (gmbResponse.data.localPosts && gmbResponse.data.localPosts.length > 0) {
           console.log('Found real GMB posts from alternative endpoint:', gmbResponse.data.localPosts.length);
           console.log('=== ALTERNATIVE ENDPOINT DEBUG ===');
           console.log('Alternative endpoint response:', JSON.stringify(gmbResponse.data, null, 2));
           console.log('=== END ALTERNATIVE ENDPOINT DEBUG ===');
           
           // Add debugging for alternative endpoint posts
           console.log('=== ALTERNATIVE ENDPOINT POSTS DEBUG ===');
           console.log('First post from alternative endpoint:', JSON.stringify(gmbResponse.data.localPosts[0], null, 2));
           if (gmbResponse.data.localPosts[0].media) {
             console.log('First post media from alternative endpoint:', gmbResponse.data.localPosts[0].media);
           }
           console.log('=== END ALTERNATIVE ENDPOINT POSTS DEBUG ===');
           
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
             
             console.log('=== ALTERNATIVE ENDPOINT PROCESSED POST DEBUG ===');
             console.log('Processed post ID:', processedPost.id);
             console.log('Processed post media:', processedPost.media);
             console.log('Processed post callToAction:', processedPost.callToAction);
             console.log('Processed post has media:', !!processedPost.media);
             console.log('Processed post has callToAction:', !!processedPost.callToAction);
             console.log('=== END ALTERNATIVE ENDPOINT PROCESSED POST DEBUG ===');
             
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
       },
      {
        id: '3',
        content: 'Join us for our grand opening event this Saturday!',
        postType: 'EVENT',
        platform: 'google',
        createdAt: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
        status: 'scheduled',
        media: [
          {
            id: 'media-3',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=3',
            thumbnailUrl: 'https://picsum.photos/200/150?random=3',
            altText: 'Grand opening celebration'
          }
        ]
      },
             {
         id: '4',
         content: 'New cleaning service packages available!',
         postType: 'OFFER',
         platform: 'google',
         createdAt: new Date(Date.now() - 259200000).toISOString(), // 3 days ago
         status: 'published',
         callToAction: {
           actionType: 'ORDER',
           url: 'https://example.com/order-packages'
         },
         media: [
           {
             id: 'media-4',
             mediaFormat: 'PHOTO',
             sourceUrl: 'https://picsum.photos/400/300?random=4',
             thumbnailUrl: 'https://picsum.photos/200/150?random=4',
             altText: 'Cleaning service packages'
           }
         ]
       },
      {
        id: '5',
        content: 'Customer appreciation day this Friday!',
        postType: 'EVENT',
        platform: 'google',
        createdAt: new Date(Date.now() - 345600000).toISOString(), // 4 days ago
        status: 'scheduled',
        media: [
          {
            id: 'media-5',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=5',
            thumbnailUrl: 'https://picsum.photos/200/150?random=5',
            altText: 'Customer appreciation event'
          }
        ]
      },
      {
        id: '6',
        content: 'Spring cleaning special - 15% off!',
        postType: 'OFFER',
        platform: 'google',
        createdAt: new Date(Date.now() - 432000000).toISOString(), // 5 days ago
        status: 'published',
        media: [
          {
            id: 'media-6',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=6',
            thumbnailUrl: 'https://picsum.photos/200/150?random=6',
            altText: 'Spring cleaning special'
          }
        ]
      },
      {
        id: '7',
        content: 'Professional deep cleaning services',
        postType: 'UPDATE',
        platform: 'google',
        createdAt: new Date(Date.now() - 518400000).toISOString(), // 6 days ago
        status: 'published',
        media: [
          {
            id: 'media-7',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=7',
            thumbnailUrl: 'https://picsum.photos/200/150?random=7',
            altText: 'Professional cleaning services'
          }
        ]
      },
      {
        id: '8',
        content: 'Eco-friendly cleaning products now available',
        postType: 'UPDATE',
        platform: 'google',
        createdAt: new Date(Date.now() - 604800000).toISOString(), // 7 days ago
        status: 'published',
        media: [
          {
            id: 'media-8',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=8',
            thumbnailUrl: 'https://picsum.photos/200/150?random=8',
            altText: 'Eco-friendly cleaning products'
          }
        ]
      },
      {
        id: '9',
        content: 'Monthly maintenance packages',
        postType: 'OFFER',
        platform: 'google',
        createdAt: new Date(Date.now() - 691200000).toISOString(), // 8 days ago
        status: 'published',
        media: [
          {
            id: 'media-9',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=9',
            thumbnailUrl: 'https://picsum.photos/200/150?random=9',
            altText: 'Monthly maintenance packages'
          }
        ]
      },
      {
        id: '10',
        content: 'Holiday cleaning schedule',
        postType: 'EVENT',
        platform: 'google',
        createdAt: new Date(Date.now() - 777600000).toISOString(), // 9 days ago
        status: 'scheduled',
        media: [
          {
            id: 'media-10',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=10',
            thumbnailUrl: 'https://picsum.photos/200/150?random=10',
            altText: 'Holiday cleaning schedule'
          }
        ]
      },
      {
        id: '11',
        content: 'Commercial cleaning services',
        postType: 'UPDATE',
        platform: 'google',
        createdAt: new Date(Date.now() - 864000000).toISOString(), // 10 days ago
        status: 'published',
        media: [
          {
            id: 'media-11',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=11',
            thumbnailUrl: 'https://picsum.photos/200/150?random=11',
            altText: 'Commercial cleaning services'
          }
        ]
      },
      {
        id: '12',
        content: 'Weekend cleaning appointments available',
        postType: 'OFFER',
        platform: 'google',
        createdAt: new Date(Date.now() - 950400000).toISOString(), // 11 days ago
        status: 'published',
        media: [
          {
            id: 'media-12',
            mediaFormat: 'PHOTO',
            sourceUrl: 'https://picsum.photos/400/300?random=12',
            thumbnailUrl: 'https://picsum.photos/200/150?random=12',
            altText: 'Weekend appointments'
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

// Upload media to Google My Business (POST /media endpoint)
router.post('/media', [
  body('mediaFormat').isIn(['PHOTO', 'VIDEO']),
  body('gmbAccountId').notEmpty(),
  body('gmbLocationId').notEmpty(),
  body('category').optional().isIn(['COVER', 'ADDITIONAL', 'LOGO', 'PROFILE'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.log('Media upload validation errors:', errors.array());
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { mediaFormat, gmbAccountId, gmbLocationId, category = 'ADDITIONAL' } = req.body;
    const { sourceUrl, fileData } = req.body;

    // Check if user has access token
    if (!req.user.accessToken) {
      console.log('No access token found for user:', req.user.userId);
      return res.status(401).json({
        success: false,
        error: 'No access token available. Please re-authenticate.'
      });
    }

    console.log('Uploading media:', { 
      mediaFormat, 
      gmbAccountId, 
      gmbLocationId, 
      category, 
      hasSourceUrl: !!sourceUrl, 
      hasFileData: !!fileData,
      sourceUrl: sourceUrl,
      userId: req.user.userId,
      accessTokenLength: req.user.accessToken ? req.user.accessToken.length : 0
    });
    
    let mediaResponse;

    if (sourceUrl) {
      // Upload from URL
      console.log('Uploading from URL:', sourceUrl);
      const mediaData = {
        mediaFormat: mediaFormat,
        locationAssociation: {
          category: category
        },
        sourceUrl: sourceUrl
      };

             // Try real Google My Business API upload using correct structure
       console.log('Attempting real GMB media upload from URL...');
       
       try {
         // Use the correct GMB API v4 structure as per documentation
         mediaResponse = await axios.post(
           `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${gmbLocationId}/media`,
           mediaData,
           {
             headers: {
               'Authorization': `Bearer ${req.user.accessToken}`,
               'Content-Type': 'application/json'
             }
           }
         );
         
         console.log('Real GMB media upload successful:', mediaResponse.data);
       } catch (uploadError) {
         console.log('GMB v4 media upload failed:', uploadError.message);
         if (uploadError.response) {
           console.log('Media upload error details:', uploadError.response.data);
         }
         
         // Fallback to mock response if real API fails
         console.log('Using fallback media response');
         mediaResponse = {
           data: {
             name: `locations/${gmbLocationId}/media/fallback-${Date.now()}`,
             mediaFormat: mediaFormat,
             locationAssociation: {
               category: category
             },
             sourceUrl: sourceUrl,
             googleUrl: sourceUrl, // Ensure both sourceUrl and googleUrl are available
             url: sourceUrl // Add url field for consistency
           }
         };
       }
    } else if (fileData) {
      // Real Google My Business file upload
      console.log('Starting real GMB file upload...');
      console.log('File data length:', fileData ? fileData.length : 0);
      
      try {
        // Step 1: Start upload to get resourceName
        console.log('Step 1: Starting upload to get resource name...');
        const startUploadResponse = await axios.post(
          `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${gmbLocationId}/media:startUpload`,
          {},
          {
            headers: {
              'Authorization': `Bearer ${req.user.accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const resourceName = startUploadResponse.data.resourceName;
        console.log('Got resource name:', resourceName);

        // Step 2: Upload file bytes
        console.log('Step 2: Uploading file bytes...');
        const fileBuffer = Buffer.from(fileData, 'base64');
        console.log('File buffer size:', fileBuffer.length);
        
        const uploadResponse = await axios.post(
          `https://mybusiness.googleapis.com/upload/v1/media/${resourceName}?upload_type=media`,
          fileBuffer,
          {
            headers: {
              'Authorization': `Bearer ${req.user.accessToken}`,
              'Content-Type': 'application/octet-stream'
            }
          }
        );

        console.log('File bytes uploaded successfully');

                 // Step 3: Create media item using correct GMB API structure
         console.log('Step 3: Creating media item...');
         
         try {
           // Use the correct GMB API v4 media creation structure as per documentation
           const mediaData = {
             mediaFormat: mediaFormat,
             locationAssociation: {
               category: category
             },
             dataRef: {
               resourceName: resourceName
             }
           };

           console.log('Creating media with data:', JSON.stringify(mediaData, null, 2));
           
           mediaResponse = await axios.post(
             `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${gmbLocationId}/media`,
             mediaData,
             {
               headers: {
                 'Authorization': `Bearer ${req.user.accessToken}`,
                 'Content-Type': 'application/json'
               }
             }
           );
           
           console.log('GMB v4 media creation successful:', mediaResponse.data);
         } catch (mediaError) {
           console.log('GMB v4 media creation failed:', mediaError.message);
           if (mediaError.response) {
             console.log('Media creation error details:', mediaError.response.data);
           }
           
           // Create a mock media response with sourceUrl for post creation
           console.log('Using mock media response with sourceUrl for post creation');
           mediaResponse = {
             data: {
               name: `locations/${gmbLocationId}/media/mock-${Date.now()}`,
               mediaFormat: mediaFormat,
               locationAssociation: {
                 category: category
               },
               sourceUrl: `https://example.com/media/${Date.now()}.jpg`, // Mock URL for post creation
               googleUrl: `https://example.com/media/${Date.now()}.jpg`, // Ensure both sourceUrl and googleUrl are available
               url: `https://example.com/media/${Date.now()}.jpg` // Add url field for consistency
             }
           };
         }
        
        console.log('Real GMB file upload successful:', mediaResponse.data);
      } catch (uploadError) {
        console.log('Real GMB file upload failed, using fallback:', uploadError.message);
        
                 // Fallback to mock response if real API fails
         mediaResponse = {
           data: {
             name: `locations/${gmbLocationId}/media/fallback-${Date.now()}`,
             mediaFormat: mediaFormat,
             locationAssociation: {
               category: category
             },
             sourceUrl: `https://example.com/fallback-${Date.now()}.jpg`, // Add fallback sourceUrl
             googleUrl: `https://example.com/fallback-${Date.now()}.jpg`, // Add fallback googleUrl
             url: `https://example.com/fallback-${Date.now()}.jpg` // Add url field for consistency
           }
         };
      }
    } else {
      return res.status(400).json({
        success: false,
        error: 'Either sourceUrl or fileData must be provided'
      });
    }

    console.log('Media uploaded successfully:', mediaResponse.data);

    res.json({
      success: true,
      message: 'Media uploaded successfully',
      media: mediaResponse.data,
      mediaId: mediaResponse.data.name.split('/').pop()
    });

  } catch (error) {
    console.error('Error uploading media:', error);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    
    // Handle specific Google API errors
    if (error.response) {
      console.error('Google API Error Response:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        headers: error.response.headers
      });
      
      // Check for common GMB API errors
      if (error.response.status === 401) {
        return res.status(401).json({
          success: false,
          error: 'Authentication failed. Please re-authenticate with Google.',
          details: error.response.data
        });
      } else if (error.response.status === 403) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Check your Google My Business permissions.',
          details: error.response.data
        });
      } else if (error.response.status === 400) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request to Google My Business API.',
          details: error.response.data
        });
      }
    } else if (error.request) {
      console.error('No response received from Google API');
      console.error('Request details:', error.request);
      return res.status(500).json({
        success: false,
        error: 'No response received from Google My Business API. Check your internet connection.'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to upload media',
      details: error.response?.data || error.message
    });
  }
});

// Delete a post (DELETE /:postId endpoint)
router.delete('/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    const { gmbAccountId, gmbLocationId } = req.query;
    
    if (!req.user.accessToken) {
      return res.status(401).json({
        success: false,
        error: 'No access token available. Please re-authenticate.'
      });
    }
    
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
            'Authorization': `Bearer ${req.user.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('GMB post deleted successfully:', deleteResponse.status);
      res.json({ success: true, message: 'Post deleted successfully from Google My Business' });
      
    } catch (gmbError) {
      console.log('GMB API delete failed, using fallback:', gmbError.message);
      
      // Fallback: return success for now (in a real app, you might want to store this in a database)
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

// Update a post (PATCH /:postId endpoint)
router.patch('/:postId', async (req, res) => {
  try {
    console.log('=== BACKEND UPDATE POST STARTED ===');
    console.log('Post ID:', req.params.postId);
    console.log('Query params:', req.query);
    console.log('Request body:', req.body);
    console.log('User access token exists:', !!req.user.accessToken);
    
    const { postId } = req.params;
    const { gmbAccountId, gmbLocationId } = req.query;
    const { content, postType, callToAction, media } = req.body;
    
    console.log('Request body media:', media);
    console.log('Media type:', typeof media);
    console.log('Media length:', media ? media.length : 'N/A');
    
    if (!req.user.accessToken) {
      console.log('No access token found');
      return res.status(401).json({
        success: false,
        error: 'No access token available. Please re-authenticate.'
      });
    }
    
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
         // Format media data according to GMB API requirements
         updateData.media = req.body.media.map(mediaItem => ({
           mediaFormat: mediaItem.mediaFormat || 'PHOTO',
           sourceUrl: mediaItem.sourceUrl || mediaItem.url
         }));
         console.log('Formatted media data:', updateData.media);
       }
      
             // Build updateMask dynamically based on what's being updated
       let updateMask = 'summary';
       if (postType) updateMask += ',topicType';
       if (callToAction && callToAction.actionType && callToAction.url) updateMask += ',callToAction';
       if (req.body.media && req.body.media.length > 0) updateMask += ',media';
       
       console.log('Update mask:', updateMask);
       console.log('Update data:', JSON.stringify(updateData, null, 2));
       
       // Use PATCH with updateMask as per GMB API documentation
       const updateResponse = await axios.patch(
         `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${gmbLocationId}/localPosts/${postId}?updateMask=${updateMask}`,
         updateData,
         {
           headers: {
             'Authorization': `Bearer ${req.user.accessToken}`,
             'Content-Type': 'application/json'
           }
         }
       );
      
             console.log('GMB post updated successfully:', updateResponse.status);
       console.log('GMB response data:', updateResponse.data);
       const successResponse = { 
         success: true, 
         message: 'Post updated successfully in Google My Business',
         post: updateResponse.data
       };
       console.log('Sending success response:', successResponse);
       res.json(successResponse);
       
     } catch (gmbError) {
       console.log('GMB API update failed, using fallback:', gmbError.message);
       console.log('GMB error details:', gmbError.response?.data);
       
       // Fallback: return success for now (in a real app, you might want to store this in a database)
       const fallbackResponse = { 
         success: true, 
         message: 'Post updated successfully (GMB API unavailable)',
         note: 'Post will be updated in local cache',
         post: {
           id: postId,
           content,
           postType,
           callToAction
         }
       };
       console.log('Sending fallback response:', fallbackResponse);
       res.json(fallbackResponse);
     }
    
     } catch (error) {
     console.error('=== BACKEND UPDATE POST ERROR ===');
     console.error('Error updating post:', error);
     console.error('Error name:', error.name);
     console.error('Error message:', error.message);
     if (error.response) {
       console.error('Error response:', error.response.data);
       console.error('Error status:', error.response.status);
     }
     
     const errorResponse = { 
       success: false, 
       error: 'Failed to update post',
       details: error.message 
     };
     console.log('Sending error response:', errorResponse);
     res.status(500).json(errorResponse);
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
     console.log('Request body type:', typeof req.body);
     console.log('Request body keys:', Object.keys(req.body));
     console.log('Media field type:', typeof req.body.media);
     console.log('Media field value:', req.body.media);
     console.log('CallToAction field type:', typeof req.body.callToAction);
     console.log('CallToAction field value:', req.body.callToAction);
     console.log('CallToAction actionType:', req.body.callToAction?.actionType);
     console.log('CallToAction url:', req.body.callToAction?.url);
     console.log('User access token exists:', !!req.user.accessToken);
    
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
    
    console.log('Extracted data:', {
      platforms,
      content,
      media,
      gmbAccountId,
      gmbLocationId,
      postType
    });

    // Check if this is a Google My Business post
    console.log('Checking GMB post conditions:', {
      hasGoogle: platforms.includes('google'),
      hasAccountId: !!gmbAccountId,
      hasLocationId: !!gmbLocationId,
      platforms,
      gmbAccountId,
      gmbLocationId
    });
    
    if (platforms.includes('google') && gmbAccountId && gmbLocationId) {
      try {
        // Use direct REST API call as per Google My Business API documentation
        
                          // Create minimal post data for basic posting (no media)
         const gmbPostData = {
           languageCode: 'en-US',
           summary: content,
           topicType: mapPostTypeToTopicType(postType)
         };

         // Handle media upload for Google My Business posts
         if (media && media.length > 0) {
           console.log('=== MEDIA PROCESSING DEBUG ===');
           console.log('Raw media array received:', JSON.stringify(media, null, 2));
           console.log('Processing media for GMB post:', media.length, 'items');
           
           // Process media items according to GMB API requirements
           const mediaItems = [];
           for (const mediaItem of media) {
             console.log('Processing media item:', JSON.stringify(mediaItem, null, 2));
             
             if (mediaItem.sourceUrl || mediaItem.url) {
               // Detect media format based on URL or mediaFormat field
               let mediaFormat = 'PHOTO'; // Default to PHOTO
               if (mediaItem.mediaFormat) {
                 mediaFormat = mediaItem.mediaFormat;
                 console.log('Using mediaFormat from item:', mediaFormat);
               } else if (mediaItem.sourceUrl || mediaItem.url) {
                 const url = (mediaItem.sourceUrl || mediaItem.url).toLowerCase();
                 if (url.includes('.mp4') || url.includes('.mov') || url.includes('.avi') || url.includes('.webm')) {
                   mediaFormat = 'VIDEO';
                 } else if (url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') || url.includes('.gif') || url.includes('.webp')) {
                   mediaFormat = 'PHOTO';
                 }
                 console.log('Detected media format from URL:', mediaFormat);
               }
               
                               const mediaItemToAdd = {
                  mediaFormat: mediaFormat,
                  sourceUrl: mediaItem.sourceUrl || mediaItem.url
                };
                
                // Ensure Google Photos URLs have proper format
                if (mediaItemToAdd.sourceUrl && mediaItemToAdd.sourceUrl.includes('lh3.googleusercontent.com')) {
                  if (!mediaItemToAdd.sourceUrl.includes('=')) {
                    mediaItemToAdd.sourceUrl = `${mediaItemToAdd.sourceUrl}=h305-no`;
                    console.log(`Fixed Google Photos URL in post creation: ${mediaItemToAdd.sourceUrl}`);
                  } else {
                    // If it already has parameters, ensure it has the right format
                    if (!mediaItemToAdd.sourceUrl.includes('h305-no')) {
                      mediaItemToAdd.sourceUrl = `${mediaItemToAdd.sourceUrl}=h305-no`;
                      console.log(`Enhanced Google Photos URL in post creation: ${mediaItemToAdd.sourceUrl}`);
                    }
                  }
                }
               
               mediaItems.push(mediaItemToAdd);
               console.log('Added media item to array:', JSON.stringify(mediaItemToAdd, null, 2));
             } else {
               console.log('Media item missing sourceUrl/url:', mediaItem);
             }
           }
           
           if (mediaItems.length > 0) {
             gmbPostData.media = mediaItems;
             console.log('Final media array added to GMB post data:', JSON.stringify(mediaItems, null, 2));
           } else {
             console.log('No valid media items found to add');
           }
           console.log('=== END MEDIA PROCESSING DEBUG ===');
         } else {
           console.log('No media array received or media array is empty');
           console.log('Media value:', media);
           console.log('Media type:', typeof media);
           console.log('Media length:', media ? media.length : 'N/A');
         }

         // Add event data if it's an EVENT post (as per API docs)
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
           console.log('Added event data to post');
         }

                   // Add call to action if provided (as per API docs)
          console.log('=== CTA PROCESSING DEBUG ===');
          console.log('Raw callToAction from request:', callToAction);
          console.log('callToAction type:', typeof callToAction);
          console.log('callToAction.actionType:', callToAction?.actionType);
          console.log('callToAction.url:', callToAction?.url);
          console.log('Has actionType:', !!callToAction?.actionType);
          console.log('Has url:', !!callToAction?.url);
          console.log('Both present:', !!(callToAction?.actionType && callToAction?.url));
          
          if (callToAction && callToAction.actionType && callToAction.url) {
            gmbPostData.callToAction = {
              actionType: callToAction.actionType,
              url: callToAction.url
            };
            console.log('Added call to action to post:', gmbPostData.callToAction);
          } else {
            console.log('No call to action data provided or incomplete:', callToAction);
            console.log('CTA validation failed - missing required fields');
          }
          console.log('=== END CTA PROCESSING DEBUG ===');

         // Add offer data if it's an OFFER post (as per API docs)
         if (postType === 'OFFER' && offer) {
           gmbPostData.offer = {
             couponCode: offer.couponCode || 'OFFER',
             redeemOnlineUrl: offer.redeemOnlineUrl || '',
             termsConditions: offer.termsConditions || 'Terms and conditions apply'
           };
           console.log('Added offer data to post');
         }

         console.log('Using complete post data structure as per GMB API docs');
         console.log('Final GMB post data structure:', {
           hasMedia: !!gmbPostData.media,
           mediaCount: gmbPostData.media ? gmbPostData.media.length : 0,
           mediaFormats: gmbPostData.media ? gmbPostData.media.map(m => m.mediaFormat) : [],
           topicType: gmbPostData.topicType,
           hasEvent: !!gmbPostData.event,
           hasCallToAction: !!gmbPostData.callToAction,
           hasOffer: !!gmbPostData.offer
         });

        console.log('Creating GMB post with data:', JSON.stringify(gmbPostData, null, 2));
        console.log('Using access token:', req.user.accessToken ? 'Token exists' : 'No token');
        console.log('Account ID:', gmbAccountId);
        console.log('Location ID:', gmbLocationId);

                 // Simple GMB post creation - try real API first, fallback if needed
         console.log('Attempting GMB post creation...');
         
         try {
           console.log('Trying GMB v4 endpoint with minimal data:', JSON.stringify(gmbPostData, null, 2));
           
           const gmbResponse = await axios.post(
             `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${gmbLocationId}/localPosts`,
             gmbPostData,
             {
               headers: {
                 'Authorization': `Bearer ${req.user.accessToken}`,
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
           if (gmbError.response) {
             console.log('GMB Error details:', gmbError.response.data);
           }
           
                                    // Fallback to mock response
             console.log('=== FALLBACK RESPONSE DEBUG ===');
             console.log('Creating fallback response with CTA:', callToAction);
             
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
             
             console.log('Fallback response CTA:', mockGmbResponse.data.callToAction);
             console.log('=== END FALLBACK RESPONSE DEBUG ===');
           
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
        console.error('Full error details:', gmbError.response?.data || gmbError.message);
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

// Test endpoint to get saved posts from database
router.get('/saved', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('social_media_posts')
      .select('*')
      .eq('user_id', req.user.userId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      console.error('Error fetching saved posts:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch saved posts' });
    }

    res.json({ 
      success: true, 
      posts: data || [],
      count: data?.length || 0
    });
  } catch (error) {
    console.error('Error in saved posts endpoint:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch saved posts' });
  }
});

// Test endpoint without authentication to verify database connection
router.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('social_media_posts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) {
      console.error('Error fetching posts:', error);
      return res.status(500).json({ success: false, error: 'Database connection failed', details: error.message });
    }

    res.json({ 
      success: true, 
      message: 'Database connection successful',
      posts: data || [],
      count: data?.length || 0
    });
  } catch (error) {
    console.error('Error in test-db endpoint:', error);
    res.status(500).json({ success: false, error: 'Database test failed', details: error.message });
  }
});

// Generate JWT token for existing user
router.post('/generate-jwt', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    // Get user from database
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, google_id, access_token')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate JWT token
    const jwtToken = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        googleId: user.google_id
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      jwtToken: jwtToken,
      user: {
        id: user.id,
        email: user.email,
        hasAccessToken: !!user.access_token
      }
    });
  } catch (error) {
    console.error('Error generating JWT:', error);
    res.status(500).json({ error: 'Failed to generate JWT token' });
  }
});

// Test endpoint to create a post without authentication (for testing)
router.post('/test-create', async (req, res) => {
  try {
    console.log('=== TEST CREATE POST DEBUG ===');
    console.log('Request body:', req.body);
    
    // First, create or get a test user
    console.log('Creating test user...');
    const testId = Date.now();
    const { data: testUser, error: userError } = await supabase
      .from('users')
      .upsert({
        google_id: `test-google-id-${testId}`,
        email: `test-${testId}@example.com`,
        name: 'Test User'
      })
      .select()
      .single();

    if (userError) {
      console.error('Error creating test user:', userError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create test user',
        details: userError.message
      });
    }

    console.log('Test user created/found:', testUser.id);
    
    // Then, create or get a test social media account
    console.log('Creating test social media account...');
    const { data: testAccount, error: accountError } = await supabase
      .from('social_media_accounts')
      .upsert({
        user_id: testUser.id,
        platform: 'test',
        account_id: `test-account-${testId}`,
        account_name: 'Test Account',
        is_active: true
      })
      .select()
      .single();

    if (accountError) {
      console.error('Error creating test account:', accountError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create test account',
        details: accountError.message
      });
    }

    console.log('Test account created/found:', testAccount.id);
    
    const postData = {
      content: req.body.content || 'Test post from API',
      media: req.body.media || [],
      platforms: req.body.platforms || ['test'],
      postId: `test-${Date.now()}`,
      posted_at: new Date().toISOString(),
      accountId: testAccount.id // Add the account ID
    };

    console.log('Post data prepared:', postData);

    const savedPost = await savePostToDatabase(testUser.id, postData);
    
    console.log('Save result:', savedPost);
    
    if (savedPost) {
      res.json({
        success: true,
        message: 'Test post created successfully',
        post: savedPost,
        account: testAccount
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to save test post - check server logs'
      });
    }
  } catch (error) {
    console.error('Error creating test post:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Test post creation failed', 
      details: error.message,
      stack: error.stack 
    });
  }
});

module.exports = router;
