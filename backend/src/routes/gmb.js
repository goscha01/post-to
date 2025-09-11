const express = require('express');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js'); // Add this line
const authMiddleware = require('../middleware/authMiddleware'); // Your existing auth middleware
const requireBusinessAuth = require('../middleware/businessAuth'); // New business auth middleware
const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Apply both middlewares to all GMB routes
router.use(authMiddleware); // First authenticate the user
router.use(requireBusinessAuth); // Then check business authentication

// Mount separate route files
router.use('/insights', require('./insights')); // Mount insights routes
router.use('/posts', require('./posts'));       // Mount posts routes

// Helper function to save post to database
const savePostToDatabase = async (userId, postData) => {
  try {
    const { data, error } = await supabase
      .from('social_media_posts')
      .insert({
        user_id: userId,
        content: postData.content,
        media: postData.media || [],
        platforms: postData.platforms || [],
        results: postData.results || [],
        posted_at: postData.posted_at || new Date().toISOString(),
        engagement_metrics: postData.engagement_metrics || {}
      })
      .select()
      .single();

    if (error) {
      console.error('Error saving post to database:', error);
      return null;
    }

    console.log('Post saved to database successfully:', data.id);
    return data;
  } catch (error) {
    console.error('Error in savePostToDatabase:', error);
    return null;
  }
};


// Helper function to format Google's date response
function formatGoogleDate(googleDate) {
  if (typeof googleDate === 'string') {
    return googleDate;
  }
  
  if (googleDate.year && googleDate.month && googleDate.day) {
    const year = googleDate.year;
    const month = googleDate.month.toString().padStart(2, '0');
    const day = googleDate.day.toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  return new Date().toISOString().split('T')[0];
}

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
        .eq('post_id', post.postId || post.id)
        .single();

      if (existingPost) {
        console.log(`Post ${post.postId || post.id} already exists in database, skipping...`);
        continue;
      }

      // Prepare post data for database
      const postData = {
        content: post.summary || post.content,
        media: post.media || [],
        platforms: [platform],
        postId: post.postId || post.id,
        posted_at: post.createTime || post.createdAt || new Date().toISOString(),
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

// Helper function to save service to database
const saveServiceToDatabase = async (userId, serviceData) => {
  try {
    console.log('=== SAVE SERVICE TO DATABASE DEBUG ===');
    console.log('User ID:', userId);
    console.log('Service data:', serviceData);

    const insertData = {
      business_profile_id: serviceData.businessProfileId || null,
      gmb_service_id: serviceData.gmbServiceId || serviceData.serviceId || null,
      service_name: serviceData.serviceName,
      price_range: serviceData.priceRange || null,
      description: serviceData.description || serviceData.serviceDescription || null,
      is_active: serviceData.isActive !== undefined ? serviceData.isActive : true
    };

    console.log('Insert data:', insertData);

    const { data, error } = await supabase
      .from('services')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Error saving service to database:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      return null;
    }

    console.log('Service saved to database successfully:', data.id);
    return data;
  } catch (error) {
    console.error('Error in saveServiceToDatabase:', error);
    console.error('Error stack:', error.stack);
    return null;
  }
};

// Helper function to save review to database
const saveReviewToDatabase = async (userId, reviewData) => {
  try {
    console.log('=== SAVE REVIEW TO DATABASE DEBUG ===');
    console.log('User ID:', userId);
    console.log('Review data:', reviewData);

    const insertData = {
      user_id: userId,
      location_id: reviewData.locationId || null,
      review_id: reviewData.reviewId || reviewData.gmbReviewId || null,
      reviewer_name: reviewData.reviewerName || reviewData.reviewer?.displayName || null,
      reviewer_photo_url: reviewData.reviewerPhotoUrl || reviewData.reviewer?.photoUrl || null,
      star_rating: reviewData.starRating || reviewData.rating || null,
      comment: reviewData.comment || null,
      create_time: reviewData.createTime || reviewData.reviewTime || new Date().toISOString(),
      update_time: reviewData.updateTime || null,
      reply_comment: reviewData.reviewReply?.comment || reviewData.replyText || null,
      reply_update_time: reviewData.reviewReply?.updateTime || reviewData.replyTime || null
    };

    console.log('Insert data:', insertData);

    const { data, error } = await supabase
      .from('gmb_reviews')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Error saving review to database:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      return null;
    }

    console.log('Review saved to database successfully:', data.id);
    return data;
  } catch (error) {
    console.error('Error in saveReviewToDatabase:', error);
    console.error('Error stack:', error.stack);
    return null;
  }
};

// Helper function to save existing reviews from API to database
const saveExistingReviewsToDatabase = async (userId, reviews, locationId, platform = 'google') => {
  try {
    console.log(`=== SAVE EXISTING REVIEWS DEBUG ===`);
    console.log(`User ID: ${userId}`);
    console.log(`Location ID: ${locationId}`);
    console.log(`Platform: ${platform}`);
    console.log(`Number of reviews: ${reviews.length}`);
    
    // Check if location exists, if not create it
    let { data: existingLocation } = await supabase
      .from('gmb_locations')
      .select('location_id')
      .eq('location_id', locationId)
      .single();

    if (!existingLocation) {
      console.log(`Location ${locationId} not found, creating it...`);
      
      // Get an existing GMB account to use
      const { data: gmbAccount } = await supabase
        .from('gmb_accounts')
        .select('account_id')
        .limit(1)
        .single();

      if (!gmbAccount) {
        console.error('No GMB account found, cannot create location');
        return [];
      }

      // Create the location
      const { data: newLocation, error: locationError } = await supabase
        .from('gmb_locations')
        .insert({
          user_id: userId,
          account_id: gmbAccount.account_id,
          location_id: locationId,
          location_name: `GMB Location ${locationId}`,
          address: 'Google My Business Location'
        })
        .select()
        .single();

      if (locationError) {
        console.error('Error creating location:', locationError);
        return [];
      }

      console.log(`Location ${locationId} created successfully`);
      existingLocation = newLocation;
    }
    
    const savedReviews = [];
    
    for (const review of reviews) {
      // Convert star rating from string to number
      let starRating = 0;
      if (review.starRating) {
        const ratingMap = {
          'ONE': 1,
          'TWO': 2,
          'THREE': 3,
          'FOUR': 4,
          'FIVE': 5
        };
        starRating = ratingMap[review.starRating] || parseInt(review.starRating) || 0;
      } else if (review.rating) {
        starRating = parseInt(review.rating) || 0;
      }

      // Extract review information
      const reviewData = {
        locationId: locationId,
        reviewId: review.reviewId || review.name?.split('/').pop() || `review-${Date.now()}-${Math.random()}`,
        gmbReviewId: review.reviewId || review.name?.split('/').pop(),
        reviewerName: review.reviewer?.displayName || review.reviewerName || 'Anonymous',
        reviewerPhotoUrl: review.reviewer?.profilePhotoUrl || review.reviewer?.photoUrl || review.reviewerPhotoUrl || null,
        starRating: starRating,
        comment: review.comment || '',
        createTime: review.createTime || review.reviewTime || new Date().toISOString(),
        updateTime: review.updateTime || null,
        reviewReply: review.reviewReply || null,
        replyText: review.replyText || review.reviewReply?.comment || null,
        replyTime: review.replyTime || review.reviewReply?.updateTime || null
      };

      // Check if review already exists in database
      console.log(`Checking if review ${reviewData.gmbReviewId} already exists...`);
      const { data: existingReview } = await supabase
        .from('gmb_reviews')
        .select('id')
        .eq('review_id', reviewData.gmbReviewId)
        .single();

      if (existingReview) {
        console.log(`Review ${reviewData.gmbReviewId} already exists in database, skipping...`);
        continue;
      }

      console.log(`Review ${reviewData.gmbReviewId} not found, proceeding to save...`);

      // Save to database
      const savedReview = await saveReviewToDatabase(userId, reviewData);
      if (savedReview) {
        savedReviews.push(savedReview);
      }
    }

    console.log(`Successfully saved ${savedReviews.length} new reviews to database`);
    return savedReviews;
  } catch (error) {
    console.error('Error saving existing reviews to database:', error);
    return [];
  }
};

// Helper function to save existing services from API to database
const saveExistingServicesToDatabase = async (userId, services, platform = 'google') => {
  try {
    console.log(`Saving ${services.length} existing services to database...`);
    
    const savedServices = [];
    
    for (const service of services) {
      // Extract service information from different service item types
      let serviceInfo = {};
      
      if (service.structuredServiceItem) {
        // Handle structured service items
        serviceInfo = {
          gmbServiceId: service.structuredServiceItem.serviceTypeId || `structured-${Date.now()}-${Math.random()}`,
          serviceName: service.structuredServiceItem.displayName || 'Structured Service',
          description: service.structuredServiceItem.description || 'Structured service from GMB',
          priceRange: service.structuredServiceItem.priceRange || null,
          isActive: true
        };
      } else if (service.freeFormServiceItem) {
        // Handle free-form service items
        console.log('=== FREE FORM SERVICE ITEM DEBUG ===');
        console.log('Raw freeFormServiceItem:', JSON.stringify(service.freeFormServiceItem, null, 2));
        
        const category = service.freeFormServiceItem.category || '';
        const label = service.freeFormServiceItem.label || '';
        
        console.log('Label type:', typeof label);
        console.log('Label value:', label);
        console.log('Label is object:', typeof label === 'object');
        console.log('Label is string:', typeof label === 'string');
        console.log('Label stringified:', JSON.stringify(label));
        
        // Check if label is actually a JSON string
        let serviceName = 'Free Form Service';
        let description = `Free form service: ${category}`;
        
        if (typeof label === 'object' && label !== null) {
          // Label is already an object, extract directly
          console.log('Label is an object, extracting directly...');
          serviceName = label.displayName || label.name || 'Free Form Service';
          description = label.description || `Free form service: ${category}`;
          console.log('Extracted from object - service name:', serviceName);
          console.log('Extracted from object - description:', description);
        } else if (typeof label === 'string' && label.length > 0) {
          // Try to parse as JSON first
          if (label.startsWith('{') && label.endsWith('}')) {
            try {
              console.log('Attempting to parse label as JSON...');
              const parsed = JSON.parse(label);
              console.log('Parsed JSON:', parsed);
              serviceName = parsed.displayName || parsed.name || 'Free Form Service';
              description = parsed.description || `Free form service: ${category}`;
              console.log('Successfully parsed JSON - service name:', serviceName);
              console.log('Successfully parsed JSON - description:', description);
            } catch (e) {
              console.log('Failed to parse label as JSON:', e.message);
              console.log('Label that failed to parse:', label);
              // Fall back to regex extraction
              const nameMatch = label.match(/"displayName":"([^"]+)"/);
              const descMatch = label.match(/"description":"([^"]+)"/);
              serviceName = nameMatch ? nameMatch[1] : 'Free Form Service';
              description = descMatch ? descMatch[1] : `Free form service: ${category}`;
              console.log('Used regex extraction - service name:', serviceName);
              console.log('Used regex extraction - description:', description);
            }
          } else {
            // Use regex extraction for non-JSON strings
            console.log('Using regex extraction for non-JSON string...');
            const nameMatch = label.match(/"displayName":"([^"]+)"/);
            const descMatch = label.match(/"description":"([^"]+)"/);
            serviceName = nameMatch ? nameMatch[1] : 'Free Form Service';
            description = descMatch ? descMatch[1] : `Free form service: ${category}`;
            console.log('Used regex extraction - service name:', serviceName);
            console.log('Used regex extraction - description:', description);
          }
        } else if (category) {
          // Extract service name from category path
          const categoryParts = category.split('/');
          const lastPart = categoryParts[categoryParts.length - 1];
          serviceName = lastPart.replace(/gcid:|_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          description = `Free form service: ${category}`;
        }
        
        console.log('Final service name:', serviceName);
        console.log('Final description:', description);
        console.log('=== END FREE FORM SERVICE DEBUG ===');
        
        serviceInfo = {
          gmbServiceId: `freeform-${Date.now()}-${Math.random()}`,
          serviceName: serviceName || 'Free Form Service',
          description: description,
          priceRange: null,
          isActive: true
        };
        
        console.log('Final service info:', serviceInfo);
        console.log('=== END FREE FORM SERVICE DEBUG ===');
      } else {
        // Handle other service types
        serviceInfo = {
          gmbServiceId: service.serviceId || service.id || `service-${Date.now()}-${Math.random()}`,
          serviceName: service.serviceName || service.displayName || service.name || 'Unknown Service',
          description: service.description || service.serviceDescription || 'Service from GMB',
          priceRange: service.priceRange || service.price || null,
          isActive: service.isActive !== undefined ? service.isActive : true
        };
      }

      // Check if service already exists in database
      const { data: existingService } = await supabase
        .from('services')
        .select('id')
        .eq('gmb_service_id', serviceInfo.gmbServiceId)
        .single();

      if (existingService) {
        console.log(`Service ${serviceInfo.gmbServiceId} already exists in database, skipping...`);
        continue;
      }

      // Save to database
      const savedService = await saveServiceToDatabase(userId, serviceInfo);
      if (savedService) {
        savedServices.push(savedService);
      }
    }

    console.log(`Successfully saved ${savedServices.length} new services to database`);
    return savedServices;
  } catch (error) {
    console.error('Error saving existing services to database:', error);
    return [];
  }
};

function getGmbAccountClient(accessToken) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken
  });
  
  return google.mybusinessaccountmanagement({
    version: 'v1',
    auth: oauth2Client
  });
}

// Initialize Google Business Profile API for locations, reviews, and media
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

// Get GMB accounts - now uses business tokens
router.get('/accounts', async (req, res) => {
  try {
    console.log('Fetching GMB accounts for user:', req.user.userId);
    
    // Use the business OAuth client provided by middleware
    const mybusiness = google.mybusinessaccountmanagement({
      version: 'v1',
      auth: req.businessOAuth2Client // This comes from the business auth middleware
    });

    const accounts = await mybusiness.accounts.list();
    
    console.log('Successfully fetched GMB accounts:', accounts.data.accounts?.length || 0);
    
    // ADD: Save accounts to database for future association
    if (accounts.data.accounts && accounts.data.accounts.length > 0) {
      for (const account of accounts.data.accounts) {
        try {
          const accountId = account.name.split('/').pop();
          
          // Save/update account in database
          const { error: accountError } = await supabase
            .from('gmb_accounts')
            .upsert({
              user_id: req.user.userId,
              account_id: accountId,
              account_name: account.accountName,
              account_type: account.type || 'PERSONAL',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }, {
              onConflict: 'user_id,account_id'
            });
            
          if (accountError) {
            console.error('Error saving account to database:', accountError);
          } else {
            console.log('✅ Saved account to database:', accountId);
          }
        } catch (dbError) {
          console.error('Database error for account:', dbError);
        }
      }
    }
    
    res.json({
      success: true,
      accounts: accounts.data.accounts || []
    });
    
  } catch (error) {
    console.error('Error fetching GMB accounts:', error);
    
    // Handle specific Google API errors
    if (error.code === 403) {
      return res.status(403).json({
        error: 'Insufficient permissions. Please ensure your Google account has access to Google My Business.',
        needsBusinessAuth: true,
        details: error.message
      });
    }
    
    if (error.code === 401) {
      return res.status(401).json({
        error: 'Business authentication expired. Please reconnect your Google My Business account.',
        needsBusinessAuth: true
      });
    }
    
    res.status(500).json({
      error: 'Failed to fetch accounts',
      details: error.message
    });
  }
});

// Get locations for a specific account
router.get('/accounts/:accountId/locations', async (req, res) => {
  try {
    const { accountId } = req.params;
    
    console.log('Fetching locations for account:', accountId);
    
    const mybusiness = google.mybusinessbusinessinformation({
      version: 'v1',
      auth: req.businessOAuth2Client
    });

    const locations = await mybusiness.accounts.locations.list({
      parent: `accounts/${accountId}`,
      pageSize: 100,
      readMask: 'name,title,storeCode,storefrontAddress,phoneNumbers,websiteUri,metadata,openInfo,regularHours,labels,languageCode'
    });
    
    console.log('Successfully fetched locations:', locations.data.locations?.length || 0);
    
    res.json({
      success: true,
      locations: locations.data.locations || []
    });

  } catch (error) {
    console.error('Error fetching locations:', error);
    
    if (error.code === 403 || error.code === 401) {
      return res.status(error.code).json({ 
        error: 'Business authentication issue. Please reconnect your Google My Business account.',
        needsBusinessAuth: true
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch locations',
      details: error.message 
    });
  }
});

// Get reviews for a location (FIXED VERSION)
router.get('/accounts/:accountId/locations/:locationId/reviews', async (req, res) => {
  try {
    const { accountId, locationId } = req.params;
    
    console.log('✅ Fetching reviews for location:', locationId);
    
    try {
      const axios = require('axios');
      const reviews = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`, // FIXED: Use business token consistently
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('✅ Successfully fetched reviews:', reviews.data.reviews?.length || 0);
      
      // Save existing reviews to database
      if (reviews.data.reviews && reviews.data.reviews.length > 0) {
        const savedReviews = await saveExistingReviewsToDatabase(
          req.user.userId, 
          reviews.data.reviews, 
          locationId, 
          'google'
        );
        console.log(`✅ Saved ${savedReviews.length} reviews to database`);
      }
      
      res.json({
        success: true,
        reviews: reviews.data.reviews || [],
        source: 'GMB_V4_API'
      });
      
    } catch (gmbV4Error) {
      console.error('❌ GMB V4 API for reviews failed:', gmbV4Error.response?.status, gmbV4Error.message);
      
      if (gmbV4Error.response?.status === 401) {
        return res.status(401).json({ 
          error: 'Business authentication expired for reviews. Please reconnect your Google My Business account.',
          needsBusinessAuth: true
        });
      }
      
      res.status(gmbV4Error.response?.status || 500).json({
        success: false,
        error: 'Failed to fetch reviews from GMB API',
        details: gmbV4Error.message
      });
    }

  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ 
      error: 'Failed to fetch reviews',
      details: error.message 
    });
  }
});

// Get a specific review (FIXED VERSION)
router.get('/accounts/:accountId/locations/:locationId/reviews/:reviewId', async (req, res) => {
  try {
    let { accountId, locationId, reviewId } = req.params;
    
    // Remove prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    reviewId = reviewId.replace('reviews/', '');
    
    console.log(`Fetching specific review: ${reviewId} for location: ${locationId} in account: ${accountId}`);
    
    try {
      const axios = require('axios');
      const reviewResponse = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}`,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`, // FIXED: Use business token consistently
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('Specific review found - ID:', reviewResponse.data.name?.split('/').pop());
      
      // Format the review data
      const review = {
        name: reviewResponse.data.name,
        reviewId: reviewResponse.data.name.split('/').pop(),
        reviewer: reviewResponse.data.reviewer,
        starRating: reviewResponse.data.starRating,
        comment: reviewResponse.data.comment,
        createTime: reviewResponse.data.createTime,
        updateTime: reviewResponse.data.updateTime,
        reviewReply: reviewResponse.data.reviewReply
      };
      
      res.json({
        success: true,
        review: review
      });
      
    } catch (gmbV4Error) {
      console.log('GMB V4 API for specific review not available:', gmbV4Error.message);
      if (gmbV4Error.response) {
        console.log('GMB V4 API error response:', JSON.stringify(gmbV4Error.response.data, null, 2));
      }
      
      res.status(404).json({
        success: false,
        error: 'Review not found or GMB V4 API not available',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    console.error('Error fetching specific review:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch specific review',
      details: error.message
    });
  }
});

// Get reviews from multiple locations (FIXED VERSION)
router.post('/accounts/:accountId/locations/batchGetReviews', async (req, res) => {
  try {
    let { accountId } = req.params;
    const { locationNames, pageSize, pageToken, orderBy, ignoreRatingOnlyReviews } = req.body;
    
    // Remove "accounts/" prefix if present
    accountId = accountId.replace('accounts/', '');
    
    console.log(`Fetching reviews from multiple locations for account: ${accountId}`);
    console.log('Batch request - Locations:', locationNames?.length || 0, 'Page size:', pageSize);
    
    try {
      const axios = require('axios');
      const batchResponse = await axios.post(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations:batchGetReviews`,
        {
          locationNames: locationNames || [],
          pageSize: pageSize || 50,
          pageToken: pageToken,
          orderBy: orderBy || 'CREATE_TIME_DESC',
          ignoreRatingOnlyReviews: ignoreRatingOnlyReviews || false
        },
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`, // FIXED: Use business token consistently
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('Batch reviews response - Reviews found:', batchResponse.data.reviews?.length || 0);
      
      res.json({
        success: true,
        reviews: batchResponse.data.reviews || [],
        nextPageToken: batchResponse.data.nextPageToken,
        totalCount: batchResponse.data.reviews?.length || 0
      });
      
    } catch (gmbV4Error) {
      console.log('GMB V4 API for batch reviews not available:', gmbV4Error.message);
      if (gmbV4Error.response) {
        console.log('GMB V4 API error response:', JSON.stringify(gmbV4Error.response.data, null, 2));
      }
      
      res.status(400).json({
        success: false,
        error: 'Batch reviews not available - GMB V4 API access required',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    console.error('Error fetching batch reviews:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch batch reviews',
      details: error.message
    });
  }
});

// Get posts for a specific location using Google My Business API v4
router.get('/accounts/:accountId/locations/:locationId/posts', async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    
    // Remove prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    
    console.log(`✅ Fetching posts for location: ${locationId} in account: ${accountId}`);
    
    try {
      const axios = require('axios');
      const postsResponse = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/localPosts`,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`, // FIXED: Use business token consistently
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('✅ Real GMB posts fetched successfully:', postsResponse.data.localPosts?.length || 0);
      
      if (!postsResponse.data.localPosts) {
        return res.json({
          success: true,
          posts: [],
          message: 'No posts found for this location'
        });
      }
      
      // Format the posts data
      const posts = postsResponse.data.localPosts.map(post => ({
        name: post.name,
        postId: post.name.split('/').pop(),
        summary: post.summary,
        createTime: post.createTime,
        updateTime: post.updateTime,
        state: post.state,
        author: post.author,
        metrics: post.metrics,
        callToAction: post.callToAction,
        media: post.media,
        topicType: post.topicType
      }));
      
      // Save existing posts to database
      const savedPosts = await saveExistingPostsToDatabase(req.user.userId, posts, 'google');
      console.log(`✅ Saved ${savedPosts.length} posts to database`);
      
      res.json({
        success: true,
        posts: posts,
        savedToDatabase: savedPosts.length,
        source: 'GMB_V4_API' // Indicate this is real data, not mock
      });
      
    } catch (gmbV4Error) {
      console.error('❌ GMB V4 API for posts failed:', gmbV4Error.response?.status, gmbV4Error.message);
      
      if (gmbV4Error.response?.status === 401) {
        return res.status(401).json({
          success: false,
          error: 'Business authentication expired for posts. Please reconnect your Google My Business account.',
          needsBusinessAuth: true
        });
      }
      
      // Don't fall back to empty - return the actual error
      res.status(gmbV4Error.response?.status || 500).json({
        success: false,
        error: 'Failed to fetch posts from GMB API',
        details: gmbV4Error.message,
        apiError: gmbV4Error.response?.data
      });
    }
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch posts',
      details: error.message
    });
  }
});

// Create a new Google My Business post (FIXED VERSION)
router.post('/accounts/:accountId/locations/:locationId/posts', async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    const { 
      languageCode = 'en-US',
      summary,
      event,
      callToAction,
      offer,
      media = [],
      topicType = 'UPDATE'
    } = req.body;
    
    // Remove "accounts/" and "locations/" prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    
    console.log(`Creating post for location: ${locationId} in account: ${accountId}`);
    console.log('Post data - Summary:', summary, 'Type:', topicType);
    
    // Validate required fields
    if (!summary) {
      return res.status(400).json({
        success: false,
        error: 'Summary is required for all posts'
      });
    }
    
    // Try to create post using Google My Business API v4 directly via HTTP request
    try {
      console.log('Attempting to create post using GMB V4 API...');
      const axios = require('axios');
      
      // Prepare the post data based on topic type
      const postData = {
        languageCode,
        summary,
        topicType
      };
      
      // Add event data if it's an event post
      if (event && topicType === 'EVENT') {
        postData.event = event;
      }
      
      // Add call to action if provided
      if (callToAction) {
        postData.callToAction = callToAction;
      }
      
      // Add offer data if it's an offer post
      if (offer && topicType === 'OFFER') {
        postData.offer = offer;
      }
      
      // Add media if provided
      if (media && media.length > 0) {
        postData.media = media.map(item => ({
          mediaFormat: item.mediaFormat || 'PHOTO',
          sourceUrl: item.sourceUrl
        }));
      }
      
      console.log('Post data prepared - Summary:', postData.summary, 'Type:', postData.topicType);
      
      // Create the post using Google My Business API v4
      const createResponse = await axios.post(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/localPosts`,
        postData,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`, // FIXED: Use business token consistently
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('Post created successfully - ID:', createResponse.data.name?.split('/').pop());
      
      // Format the response
      const createdPost = {
        name: createResponse.data.name,
        postId: createResponse.data.name.split('/').pop(),
        summary: createResponse.data.summary,
        topicType: createResponse.data.topicType,
        createTime: createResponse.data.createTime,
        state: createResponse.data.state,
        event: createResponse.data.event,
        callToAction: createResponse.data.callToAction,
        offer: createResponse.data.offer,
        media: createResponse.data.media
      };
      
      // Save post to database
      const dbPostData = {
        content: summary,
        media: media || [],
        platforms: ['google'],
        results: [{
          platform: 'google',
          postId: createResponse.data.name.split('/').pop(),
          success: true,
          response: createResponse.data
        }],
        posted_at: new Date().toISOString()
      };
      
      const savedPost = await savePostToDatabase(req.user.userId, dbPostData);
      
      res.json({
        success: true,
        message: 'Post created successfully on Google My Business',
        post: createdPost,
        databaseId: savedPost?.id
      });
      
    } catch (gmbV4Error) {
      console.log('GMB V4 API for post creation not available:', gmbV4Error.message);
      if (gmbV4Error.response) {
        console.log('GMB V4 API error response:', JSON.stringify(gmbV4Error.response.data, null, 2));
      }
      
      // Fallback error if GMB V4 API is not available
      res.status(400).json({
        success: false,
        error: 'Post creation not available - GMB V4 API access required',
        message: 'This feature requires Google My Business API v4 access',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    console.error('Error creating GMB post:', error);
    
    if (error.response && error.response.data) {
      console.error('Full error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create GMB post',
      details: error.message,
      apiError: error.response?.data
    });
  }
});

// Reply to a review (FIXED VERSION)
router.put('/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply', async (req, res) => {
  try {
    let { accountId, locationId, reviewId } = req.params;
    const { comment } = req.body;
    
    // Remove prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    reviewId = reviewId.replace('reviews/', '');
    
    console.log(`Replying to review: ${reviewId} for location: ${locationId} in account: ${accountId}`);
    console.log('Reply data - Comment length:', comment?.length || 0);
    
    // Validate required fields
    if (!comment) {
      return res.status(400).json({
        success: false,
        error: 'Comment is required for review reply'
      });
    }
    
    try {
      const axios = require('axios');
      const replyResponse = await axios.put(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`,
        { comment },
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`, // FIXED: Use business token consistently
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('Review reply created/updated successfully');
      
      // Format the reply data
      const reply = {
        name: replyResponse.data.name,
        comment: replyResponse.data.comment,
        updateTime: replyResponse.data.updateTime
      };
      
      res.json({
        success: true,
        message: 'Review reply created/updated successfully',
        reply: reply
      });
      
    } catch (gmbV4Error) {
      console.log('GMB V4 API for review reply not available:', gmbV4Error.message);
      if (gmbV4Error.response) {
        console.log('GMB V4 API error response:', JSON.stringify(gmbV4Error.response.data, null, 2));
      }
      
      res.status(400).json({
        success: false,
        error: 'Review reply not available - GMB V4 API access required',
        message: 'This feature requires Google My Business API v4 access',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    console.error('Error replying to review:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to reply to review',
      details: error.message
    });
  }
});

// Delete a review reply (FIXED VERSION)
router.delete('/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply', async (req, res) => {
  try {
    let { accountId, locationId, reviewId } = req.params;
    
    // Remove prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    reviewId = reviewId.replace('reviews/', '');
    
    console.log(`Deleting reply for review: ${reviewId} for location: ${locationId} in account: ${accountId}`);
    
    try {
      const axios = require('axios');
      await axios.delete(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`, // FIXED: Use business token consistently
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('Review reply deleted successfully');
      
      res.json({
        success: true,
        message: 'Review reply deleted successfully'
      });
      
    } catch (gmbV4Error) {
      console.log('GMB V4 API for review reply deletion not available:', gmbV4Error.message);
      if (gmbV4Error.response) {
        console.log('GMB V4 API error response:', JSON.stringify(gmbV4Error.response.data, null, 2));
      }
      
      res.status(400).json({
        success: false,
        error: 'Review reply deletion not available - GMB V4 API access required',
        message: 'This feature requires Google My Business API v4 access',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    console.error('Error deleting review reply:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete review reply',
      details: error.message
    });
  }
});

// Get media for a location (FIXED VERSION)
router.get('/accounts/:accountId/locations/:locationId/media', async (req, res) => {
  try {
    const { accountId, locationId } = req.params;
    
    console.log('✅ Fetching media for location:', locationId);
    
    try {
      const axios = require('axios');
      const media = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/media`,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`, // FIXED: Use business token consistently
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('✅ Successfully fetched media:', media.data.mediaItems?.length || 0);
      
      // Separate logos and profile pictures
      const mediaItems = media.data.mediaItems || [];
      const logos = mediaItems.filter(item => item.mediaFormat === 'LOGO');
      const profilePicture = mediaItems.find(item => item.mediaFormat === 'PROFILE_PICTURE');
      
      res.json({
        success: true,
        mediaItems: mediaItems,
        logos: logos,
        profilePicture: profilePicture || null,
        source: 'GMB_V4_API'
      });
      
    } catch (gmbV4Error) {
      console.error('❌ GMB V4 API for media failed:', gmbV4Error.response?.status, gmbV4Error.message);
      
      if (gmbV4Error.response?.status === 401) {
        return res.status(401).json({ 
          error: 'Business authentication expired for media. Please reconnect your Google My Business account.',
          needsBusinessAuth: true
        });
      }
      
      res.status(gmbV4Error.response?.status || 500).json({
        success: false,
        error: 'Failed to fetch media from GMB API',
        details: gmbV4Error.message
      });
    }

  } catch (error) {
    console.error('Error fetching media:', error);
    res.status(500).json({ 
      error: 'Failed to fetch media',
      details: error.message 
    });
  }
});

// Get predefined services by category name
router.get('/categories', async (req, res) => {
  try {
    const { regionCode = 'US', languageCode = 'en', filter, view = 'FULL' } = req.query;
    
    const gmbClient = google.mybusinessbusinessinformation({
      version: 'v1',
      auth: req.businessOAuth2Client // Use business auth instead of accessToken
    });
    
    const params = {
      regionCode,
      languageCode,
      view
    };
    
    if (filter) {
      params.filter = filter;
    }
    
    const response = await gmbClient.categories.list(params);
    
    res.json({
      success: true,
      categories: response.data.categories || []
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      status: error.status,
      response: error.response?.data
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch categories',
      details: error.message
    });
  }
});

// Get predefined services by category ID
router.get('/categories/batchGet', async (req, res) => {
  try {
    const { regionCode = 'US', languageCode = 'en', names, view = 'FULL' } = req.query;
    
    if (!names) {
      return res.status(400).json({
        success: false,
        error: 'Category names are required'
      });
    }
    
    const gmbClient = google.mybusinessbusinessinformation({
      version: 'v1',
      auth: req.businessOAuth2Client // Use business auth instead of accessToken
    });
    
    // Convert category IDs to proper format (categories/gcid:category_id)
    const formattedNames = Array.isArray(names) ? names : [names];
    const properNames = formattedNames.map(name => {
      if (name.startsWith('gcid:')) {
        return `categories/${name}`;
      } else if (name.startsWith('categories/')) {
        return name;
      } else {
        return `categories/gcid:${name}`;
      }
    });
    
    const response = await gmbClient.categories.batchGet({
      regionCode,
      languageCode,
      names: properNames,
      view
    });
    
    if (response.data.categories && response.data.categories.length > 0) {
      const category = response.data.categories[0];
      console.log(`📋 SERVICES AVAILABLE for "${category.displayName}" (${category.name}):`);
      console.log('Full category object:', JSON.stringify(category, null, 2));
      
      if (category.serviceTypes && category.serviceTypes.length > 0) {
        console.log('Service types found:', category.serviceTypes.length);
        console.log('First service type:', JSON.stringify(category.serviceTypes[0], null, 2));
        
        // Check if service types have actual data
        const hasValidServices = category.serviceTypes.some(service => 
          service.displayName || service.serviceTypeId
        );
        
        if (!hasValidServices) {
          console.log('Service types are empty, providing fallback services');
          // Provide fallback services for house cleaning (as free-form services)
          const fallbackServices = [
            { displayName: 'Deep Cleaning', description: 'Comprehensive deep cleaning service' },
            { displayName: 'Regular Cleaning', description: 'Standard house cleaning service' },
            { displayName: 'Move-in/Move-out Cleaning', description: 'Cleaning for moving situations' },
            { displayName: 'Office Cleaning', description: 'Commercial office cleaning' },
            { displayName: 'Post-Construction Cleaning', description: 'Cleaning after construction work' },
            { displayName: 'Upholstery Cleaning', description: 'Furniture and upholstery cleaning' },
            { displayName: 'Mattress Cleaning', description: 'Specialized mattress cleaning' },
            { displayName: 'Window Cleaning', description: 'Interior and exterior window cleaning' }
          ];
          
          category.serviceTypes = fallbackServices;
          console.log('Using fallback services:', fallbackServices);
        }
        
        category.serviceTypes.forEach((service, index) => {
          console.log(`  ${index + 1}. ${service.displayName} (${service.serviceTypeId})`);
        });
      } else {
        console.log('  No predefined services available for this category');
      }
    }
    
    res.json({
      success: true,
      categories: response.data.categories || []
    });
  } catch (error) {
    console.error('Error fetching categories by ID:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      status: error.status,
      response: error.response?.data
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch categories by ID',
      details: error.message
    });
  }
});

// Get existing services for a location
router.get('/locations/:locationId/services', async (req, res) => {
  try {
    const { locationId } = req.params;
    
    const gmbClient = google.mybusinessbusinessinformation({
      version: 'v1',
      auth: req.businessOAuth2Client // Use business auth instead of accessToken
    });
    
    console.log('Backend: Fetching services for location:', locationId);
    
    const response = await gmbClient.locations.get({
      name: `locations/${locationId}`,
      readMask: 'serviceItems'
    });
    
    console.log('Backend: Google API response for location services:', response.data);
    console.log('Backend: Service items count:', response.data.serviceItems ? response.data.serviceItems.length : 0);
    
    if (response.data.serviceItems && response.data.serviceItems.length > 0) {
      console.log('Backend: First few service items:');
      response.data.serviceItems.slice(0, 3).forEach((item, index) => {
        console.log(`  Service ${index + 1}:`, item);
        if (item.structuredServiceItem) {
          console.log(`    - Structured:`, item.structuredServiceItem);
        }
        if (item.freeFormServiceItem) {
          console.log(`    - Free form:`, item.freeFormServiceItem);
        }
      });
    }

    // Save services to database
    const savedServices = await saveExistingServicesToDatabase(req.user.userId, response.data.serviceItems || [], 'google');
    console.log(`Saved ${savedServices.length} services to database`);
    
    res.json({
      success: true,
      serviceItems: response.data.serviceItems || [],
      savedToDatabase: savedServices.length
    });
  } catch (error) {
    console.error('Error fetching location services:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch location services',
      details: error.message
    });
  }
});

// Update services for a location
router.patch('/locations/:locationId/services', async (req, res) => {
  try {
    const { locationId } = req.params;
    const { serviceItems } = req.body;
    
    console.log('Backend: Updating services for location:', locationId);
    console.log('Backend: Service items received:', JSON.stringify(serviceItems, null, 2));
    
    if (!serviceItems || !Array.isArray(serviceItems)) {
      return res.status(400).json({
        success: false,
        error: 'Service items array is required'
      });
    }
    
    const gmbClient = google.mybusinessbusinessinformation({
      version: 'v1',
      auth: req.businessOAuth2Client // Use business auth instead of accessToken
    });
    
    const response = await gmbClient.locations.patch({
      name: `locations/${locationId}`,
      updateMask: 'serviceItems',
      requestBody: {
        serviceItems: serviceItems
      }
    });
    
    res.json({
      success: true,
      location: response.data
    });
  } catch (error) {
    console.error('Error updating location services:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      status: error.status,
      response: error.response?.data,
      requestBody: req.body
    });
    
    // Log the specific Google API error
    if (error.response?.data) {
      console.error('Google API Error Response:', JSON.stringify(error.response.data, null, 2));
    }
    
    // Log the request that was sent to Google
    console.error('Request sent to Google:', {
      name: `locations/${req.params.locationId}`,
      updateMask: 'serviceItems',
      requestBody: {
        serviceItems: req.body.serviceItems
      }
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to update location services',
      details: error.message,
      googleError: error.response?.data
    });
  }
});

// Get account details
router.get('/accounts/:accountId', async (req, res) => {
  try {
    let { accountId } = req.params;
    
    const gmbClient = google.mybusinessaccountmanagement({
      version: 'v1',
      auth: req.businessOAuth2Client // Use business auth instead of accessToken
    });
    
    // Remove "accounts/" prefix if present
    accountId = accountId.replace('accounts/', '');
    
    // Get specific account details
    const accountResponse = await gmbClient.accounts.get({
      name: `accounts/${accountId}`
    });
    
    const account = accountResponse.data;
    
    res.json({
      success: true,
      account: {
        name: account.name,
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        type: account.type,
        role: account.role,
        state: account.state,
        permissionLevel: account.permissionLevel
      }
    });
  } catch (error) {
    console.error('Error fetching GMB account:', error);
    
    if (error.response && error.response.data) {
      console.error('Full error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch GMB account',
      details: error.message,
      apiError: error.response?.data
    });
  }
});

// Update account
router.put('/accounts/:accountId', async (req, res) => {
  try {
    let { accountId } = req.params;
    const updateData = req.body;
    
    const gmbClient = google.mybusinessaccountmanagement({
      version: 'v1',
      auth: req.businessOAuth2Client // Use business auth instead of accessToken
    });
    
    // Remove "accounts/" prefix if present
    accountId = accountId.replace('accounts/', '');
    
    // Update account
    const updateResponse = await gmbClient.accounts.patch({
      name: `accounts/${accountId}`,
      requestBody: updateData,
      updateMask: Object.keys(updateData).join(',')
    });
    
    res.json({
      success: true,
      message: 'Account updated successfully',
      accountId: accountId,
      updatedAccount: updateResponse.data
    });
  } catch (error) {
    console.error('Error updating GMB account:', error);
    
    if (error.response && error.response.data) {
      console.error('Full error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update GMB account',
      details: error.message,
      apiError: error.response?.data
    });
  }
});

// INSIGHTS ENDPOINTS (FIXED VERSIONS)
router.post('/locations/:locationId/insights', authMiddleware, requireBusinessAuth, async (req, res) => {
  try {
    const { locationId } = req.params;
    const { metricRequests, timeRange } = req.body;
    
    console.log('Insights request for location:', locationId);
    console.log('Metrics requested:', metricRequests);
    console.log('Time range:', timeRange);
    
    if (!metricRequests || !timeRange) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: metricRequests and timeRange'
      });
    }

    const accessToken = req.businessOAuth2Client.credentials.access_token;
    
    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: 'Business authentication required',
        needsBusinessAuth: true
      });
    }

    const startDate = new Date(timeRange.startTime);
    const endDate = new Date(timeRange.endTime);

    // Metric mapping for Google Business Profile API
    const metricMap = {
      'VIEWS_MAPS': ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
      'VIEWS_SEARCH': ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
      'ACTIONS_PHONE': ['CALL_CLICKS'],
      'ACTIONS_WEBSITE': ['WEBSITE_CLICKS'],
      'ACTIONS_DRIVING_DIRECTIONS': ['BUSINESS_DIRECTION_REQUESTS'],
      'BUSINESS_CONVERSATIONS': ['BUSINESS_CONVERSATIONS'],
      'BUSINESS_BOOKINGS': ['BUSINESS_BOOKINGS'],
      'BUSINESS_FOOD_ORDERS': ['BUSINESS_FOOD_ORDERS'],
      'BUSINESS_FOOD_MENU_CLICKS': ['BUSINESS_FOOD_MENU_CLICKS']
    };

    const allMetricsData = [];
    
    for (const metricRequest of metricRequests) {
      const gmbMetric = metricRequest.metric;
      const apiMetrics = metricMap[gmbMetric] || [gmbMetric];
      
      let totalValue = 0;
      
      for (const apiMetric of apiMetrics) {
        try {
          const response = await axios.get(
            `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              },
              params: {
                dailyMetrics: apiMetric,
                'dailyRange.startDate.year': startDate.getFullYear(),
                'dailyRange.startDate.month': startDate.getMonth() + 1,
                'dailyRange.startDate.day': startDate.getDate(),
                'dailyRange.endDate.year': endDate.getFullYear(),
                'dailyRange.endDate.month': endDate.getMonth() + 1,
                'dailyRange.endDate.day': endDate.getDate()
              }
            }
          );
          
          // Process response to extract values
          let metricValue = 0;
          if (response.data.multiDailyMetricTimeSeries) {
            response.data.multiDailyMetricTimeSeries.forEach(metricSeries => {
              if (metricSeries.dailyMetricTimeSeries) {
                metricSeries.dailyMetricTimeSeries.forEach(dailySeries => {
                  if (dailySeries.timeSeries && dailySeries.timeSeries.datedValues) {
                    dailySeries.timeSeries.datedValues.forEach(datedValue => {
                      if (datedValue.value) {
                        metricValue += parseInt(datedValue.value) || 0;
                      }
                    });
                  }
                });
              }
            });
          }
          
          totalValue += metricValue;
          console.log(`✅ ${apiMetric}: ${metricValue}`);
          
        } catch (error) {
          console.error(`❌ Failed to fetch ${apiMetric}:`, error.response?.data || error.message);
        }
      }
      
      allMetricsData.push({
        gmbMetric,
        totalValue
      });
    }

    // Format response to match expected frontend structure
    const locationMetrics = allMetricsData.map(metricData => ({
      metric: metricData.gmbMetric,
      metricValues: [{
        value: metricData.totalValue.toString(),
        time: new Date().toISOString()
      }]
    }));

    console.log('✅ Insights fetched successfully:', locationMetrics.length, 'metrics');

    res.json({
      success: true,
      data: { locationMetrics }
    });

  } catch (error) {
    console.error('Error fetching insights:', error);
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        success: false,
        error: 'Business authentication expired. Please reconnect your Google My Business account.',
        needsBusinessAuth: true
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch insights',
      message: error.message
    });
  }
});

router.post('/locations/:locationId/insights/timeline', authMiddleware, requireBusinessAuth, async (req, res) => {
  try {
    const { locationId } = req.params;
    const { metricRequests, timeRange } = req.body;
    
    console.log('Timeline insights request for location:', locationId);
    
    if (!metricRequests || !timeRange) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: metricRequests and timeRange'
      });
    }

    const accessToken = req.businessOAuth2Client.credentials.access_token;
    
    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: 'Business authentication required',
        needsBusinessAuth: true
      });
    }

    const startDate = new Date(timeRange.startTime);
    const endDate = new Date(timeRange.endTime);

    const metricMap = {
      'VIEWS_MAPS': ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
      'VIEWS_SEARCH': ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
      'ACTIONS_PHONE': ['CALL_CLICKS'],
      'ACTIONS_WEBSITE': ['WEBSITE_CLICKS'],
      'ACTIONS_DRIVING_DIRECTIONS': ['BUSINESS_DIRECTION_REQUESTS']
    };

    const timelineMetrics = [];
    
    for (const metricRequest of metricRequests) {
      const gmbMetric = metricRequest.metric;
      const apiMetrics = metricMap[gmbMetric] || [gmbMetric];
      
      const dailyTotals = {};
      let totalValue = 0;
      
      for (const apiMetric of apiMetrics) {
        try {
          const response = await axios.get(
            `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              },
              params: {
                dailyMetrics: apiMetric,
                'dailyRange.startDate.year': startDate.getFullYear(),
                'dailyRange.startDate.month': startDate.getMonth() + 1,
                'dailyRange.startDate.day': startDate.getDate(),
                'dailyRange.endDate.year': endDate.getFullYear(),
                'dailyRange.endDate.month': endDate.getMonth() + 1,
                'dailyRange.endDate.day': endDate.getDate()
              }
            }
          );
          
          // Process daily timeline data
          if (response.data.multiDailyMetricTimeSeries) {
            response.data.multiDailyMetricTimeSeries.forEach(metricSeries => {
              if (metricSeries.dailyMetricTimeSeries) {
                metricSeries.dailyMetricTimeSeries.forEach(dailySeries => {
                  if (dailySeries.timeSeries && dailySeries.timeSeries.datedValues) {
                    dailySeries.timeSeries.datedValues.forEach(datedValue => {
                      if (datedValue.value && datedValue.date) {
                        const dateStr = formatGoogleDate(datedValue.date);
                        const value = parseInt(datedValue.value) || 0;
                        
                        if (!dailyTotals[dateStr]) {
                          dailyTotals[dateStr] = 0;
                        }
                        dailyTotals[dateStr] += value;
                        totalValue += value;
                      }
                    });
                  }
                });
              }
            });
          }
          
        } catch (error) {
          console.error(`Failed to fetch timeline data for ${apiMetric}:`, error.response?.data || error.message);
        }
      }
      
      // Convert to timeline format
      const timeSeriesData = [];
      const daysDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
      
      for (let i = 0; i < daysDiff; i++) {
        const currentDate = new Date(startDate);
        currentDate.setDate(currentDate.getDate() + i);
        const dateStr = currentDate.toISOString().split('T')[0];
        
        timeSeriesData.push({
          date: dateStr,
          value: dailyTotals[dateStr] || 0,
          timestamp: currentDate.toISOString()
        });
      }
      
      timelineMetrics.push({
        metric: gmbMetric,
        timeSeriesData,
        totalValue
      });
    }

    res.json({
      success: true,
      data: {
        locationId,
        dateRange: {
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0]
        },
        metrics: timelineMetrics
      }
    });

  } catch (error) {
    console.error('Error fetching timeline data:', error);
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        success: false,
        error: 'Business authentication expired. Please reconnect your Google My Business account.',
        needsBusinessAuth: true
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch timeline insights',
      message: error.message
    });
  }
});

// Test endpoint to create a service without authentication (for testing)
router.post('/test-create-service', async (req, res) => {
  try {
    console.log('=== TEST CREATE SERVICE DEBUG ===');
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

    const serviceData = {
      gmbServiceId: `test-service-${testId}`,
      serviceName: req.body.serviceName || 'Test Service',
      description: req.body.description || 'Test service description',
      priceRange: req.body.priceRange || '$50-100',
      isActive: true
    };

    console.log('Service data prepared:', serviceData);

    const savedService = await saveServiceToDatabase(testUser.id, serviceData);

    console.log('Save result:', savedService);

    if (savedService) {
      res.json({
        success: true,
        message: 'Test service created successfully',
        service: savedService
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to save test service - check server logs'
      });
    }
  } catch (error) {
    console.error('Error creating test service:', error);
    res.status(500).json({
      success: false,
      error: 'Test service creation failed',
      details: error.message,
      stack: error.stack
    });
  }
});

// Test endpoint to create a review without authentication (for testing)
router.post('/test-create-review', async (req, res) => {
  try {
    console.log('=== TEST CREATE REVIEW DEBUG ===');
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

    // Use an existing GMB account
    console.log('Getting existing GMB account...');
    const { data: existingAccount, error: accountError } = await supabase
      .from('gmb_accounts')
      .select('account_id, account_name')
      .limit(1)
      .single();

    if (accountError || !existingAccount) {
      console.error('Error getting existing GMB account:', accountError);
      return res.status(500).json({
        success: false,
        error: 'No GMB account found - please create one first',
        details: accountError?.message || 'No accounts available'
      });
    }

    console.log('Using existing GMB account:', existingAccount.account_id);

    // Create a test location
    console.log('Creating test location...');
    const { data: testLocation, error: locationError } = await supabase
      .from('gmb_locations')
      .insert({
        user_id: testUser.id,
        account_id: existingAccount.account_id, // Use the existing GMB account_id
        location_id: `test-location-${testId}`,
        location_name: 'Test Location',
        address: '123 Test Street, Test City, TC 12345'
      })
      .select()
      .single();

    if (locationError) {
      console.error('Error creating test location:', locationError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create test location',
        details: locationError.message
      });
    }

    console.log('Test location created:', testLocation.location_id);

    const reviewData = {
      locationId: testLocation.location_id,
      reviewId: `test-review-${testId}`,
      gmbReviewId: `test-review-${testId}`,
      reviewerName: req.body.reviewerName || 'Test Reviewer',
      starRating: req.body.starRating || 5,
      comment: req.body.comment || 'This is a test review',
      createTime: new Date().toISOString(),
      replyText: req.body.replyText || null,
      replyTime: req.body.replyTime || null
    };

    console.log('Review data prepared:', reviewData);

    const savedReview = await saveReviewToDatabase(testUser.id, reviewData);

    console.log('Save result:', savedReview);

    if (savedReview) {
      res.json({
        success: true,
        message: 'Test review created successfully',
        review: savedReview
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to save test review - check server logs'
      });
    }
  } catch (error) {
    console.error('Error creating test review:', error);
    res.status(500).json({
      success: false,
      error: 'Test review creation failed',
      details: error.message,
      stack: error.stack
    });
  }
});

// Test endpoint (no auth required) - remove this in production
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'GMB routes are working!',
    endpoints: {
      accounts: 'GET /api/gmb/accounts',
      locations: 'GET /api/gmb/accounts/:accountId/locations',
      reviews: 'GET /api/gmb/accounts/:accountId/locations/:locationId/reviews',
      'specific-review': 'GET /api/gmb/accounts/:accountId/locations/:locationId/reviews/:reviewId',
      'batch-reviews': 'POST /api/gmb/accounts/:accountId/locations/batchGetReviews',
      'reply-to-review': 'PUT /api/gmb/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply',
      'delete-reply': 'DELETE /api/gmb/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply',
      posts: 'GET /api/gmb/accounts/:accountId/locations/:locationId/posts',
      'create-post': 'POST /api/gmb/accounts/:accountId/locations/:locationId/posts',
      media: 'GET /api/gmb/accounts/:accountId/locations/:locationId/media',
      'insights': 'POST /api/gmb/locations/:locationId/insights',
      'insights-timeline': 'POST /api/gmb/locations/:locationId/insights/timeline'
    },
    testData: {
      accountId: '109194636448236279020',
      locationId: '2141374650782668963'
    },
    note: 'All endpoints now use consistent business authentication',
    troubleshooting: {
      reviews: 'If reviews are empty, check Google Cloud Console to enable Google My Business API v4',
      oauth: 'Ensure OAuth scopes include https://www.googleapis.com/auth/business.manage',
      apis: 'Enable these APIs: Google My Business API, Business Profile API, Places API'
    }
  });
});

// API Status Check endpoint
router.get('/api-status', async (req, res) => {
  try {
    // Test different API endpoints to see what's available
    const status = {
      businessProfile: false,
      gmbV4: false,
      places: false,
      drive: false,
      errors: []
    };
    
    try {
      // Test Business Profile API
      const businessProfileClient = google.mybusinessbusinessinformation({
        version: 'v1',
        auth: req.businessOAuth2Client // Use business auth
      });
      await businessProfileClient.accounts.list();
      status.businessProfile = true;
    } catch (error) {
      status.errors.push(`Business Profile API: ${error.message}`);
    }
    
    try {
      // Test GMB V4 API
      const axios = require('axios');
      await axios.get('https://mybusiness.googleapis.com/v4/accounts', {
        headers: { 'Authorization': `Bearer ${req.businessToken}` } // Use business token
      });
      status.gmbV4 = true;
    } catch (error) {
      status.errors.push(`GMB V4 API: ${error.response?.status || 'No response'} - ${error.message}`);
    }
    
    try {
      // Test Places API
      const placesClient = google.places({
        version: 'v1',
        auth: req.businessOAuth2Client // Use business auth
      });
      await placesClient.places.get({ name: 'places/ChIJN1t_tDeuEmsRUsoyG83frY4' });
      status.places = true;
    } catch (error) {
      status.errors.push(`Places API: ${error.message}`);
    }
    
    try {
      // Test Drive API
      const driveClient = google.drive({
        version: 'v3',
        auth: req.businessOAuth2Client // Use business auth
      });
      await driveClient.files.list({ pageSize: 1 });
      status.drive = true;
    } catch (error) {
      status.errors.push(`Drive API: ${error.message}`);
    }
    
    res.json({
      success: true,
      status,
      message: 'API availability check completed',
      recommendations: {
        reviews: status.gmbV4 ? 'GMB V4 API is available - reviews should work' : 'Enable Google My Business API v4 in Google Cloud Console',
        oauth: 'Check OAuth scopes include business.manage permission',
        apis: 'Enable required APIs in Google Cloud Console'
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to check API status',
      details: error.message
    });
  }
});

// List all media for a location using GMB API v4
router.get('/accounts/:accountId/locations/:locationId/media-v4', async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    
    // Remove prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    
    console.log(`Fetching all media for location: ${locationId} in account: ${accountId} using GMB V4 API`);
    
    try {
      // Try to access Google My Business API v4 directly via HTTP request
      const axios = require('axios');
      const mediaResponse = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/media`,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`, // Use business token
            'Content-Type': 'application/json'
          }
        }
      );
      
      res.json({
        success: true,
        media: mediaResponse.data.mediaItems || [],
        totalCount: mediaResponse.data.mediaItems?.length || 0
      });
      
    } catch (gmbV4Error) {
      console.log('GMB V4 API not available:', gmbV4Error.message);
      res.status(404).json({
        success: false,
        error: 'GMB V4 API not available',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    console.error('Error fetching media:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch media',
      details: error.message
    });
  }
});

// Get specific media item using GMB API v4
router.get('/accounts/:accountId/locations/:locationId/media/:mediaId', async (req, res) => {
  try {
    let { accountId, locationId, mediaId } = req.params;
    
    // Remove prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    mediaId = mediaId.replace('media/', '');
    
    console.log(`Fetching media item: ${mediaId} for location: ${locationId} in account: ${accountId}`);
    
    try {
      // Try to access Google My Business API v4 directly via HTTP request
      const axios = require('axios');
      const mediaResponse = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/media/${mediaId}`,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`, // Use business token
            'Content-Type': 'application/json'
          }
        }
      );
      
      res.json({
        success: true,
        media: mediaResponse.data
      });
      
    } catch (gmbV4Error) {
      console.log('GMB V4 API not available:', gmbV4Error.message);
      res.status(404).json({
        success: false,
        error: 'Media not found or GMB V4 API not available',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    console.error('Error fetching media item:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch media item',
      details: error.message
    });
  }
});

// Test GMB V4 API endpoint
router.get('/test-gmb-v4', async (req, res) => {
  try {
    console.log('Testing GMB V4 API access...');
    
    try {
      const axios = require('axios');
      
      // Test basic GMB V4 API access
      const accountsResponse = await axios.get('https://mybusiness.googleapis.com/v4/accounts', {
        headers: {
          'Authorization': `Bearer ${req.businessToken}`, // Use business token
          'Content-Type': 'application/json'
        }
      });
      
      console.log('GMB V4 API accounts response:', accountsResponse.status, accountsResponse.data);
      
      res.json({
        success: true,
        message: 'GMB V4 API is accessible',
        accounts: accountsResponse.data.accounts || [],
        status: accountsResponse.status
      });
      
    } catch (gmbError) {
      console.log('GMB V4 API test failed:', gmbError.message);
      
      if (gmbError.response) {
        console.log('Error response:', gmbError.response.status, gmbError.response.data);
        
        res.json({
          success: false,
          message: 'GMB V4 API test failed',
          error: {
            status: gmbError.response.status,
            message: gmbError.response.data?.error?.message || gmbError.message,
            code: gmbError.response.data?.error?.code || 'unknown',
            details: gmbError.response.data?.error?.details || []
          },
          troubleshooting: {
            api: 'Check if Google My Business API v4 is enabled in Google Cloud Console',
            oauth: 'Verify OAuth scopes include business.manage permission',
            billing: 'Ensure billing is enabled for the Google Cloud project'
          }
        });
      } else {
        res.json({
          success: false,
          message: 'GMB V4 API test failed - no response',
          error: gmbError.message,
          troubleshooting: 'Check network connectivity and API endpoint availability'
        });
      }
    }
    
  } catch (error) {
    console.error('Error testing GMB V4 API:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test GMB V4 API',
      details: error.message
    });
  }
});

// Profile image proxy endpoint (no auth required)
router.get('/proxy-image', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL parameter is required'
      });
    }
    
    console.log('Proxying image:', url);
    
    const axios = require('axios');
    const imageResponse = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    console.log('Image response status:', imageResponse.status);
    console.log('Image response headers:', imageResponse.headers);
    console.log('Image data size:', imageResponse.data.length, 'bytes');
    
    // Convert to base64 data URL to avoid CORS issues
    const base64 = Buffer.from(imageResponse.data).toString('base64');
    const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
    const dataUrl = `data:${contentType};base64,${base64}`;
    
    console.log('Sending base64 data URL, length:', dataUrl.length);
    
    // Return the data URL as JSON
    res.json({
      success: true,
      dataUrl: dataUrl,
      contentType: contentType,
      size: imageResponse.data.length
    });
    
  } catch (error) {
    console.error('Error proxying image:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to proxy image',
      details: error.message
    });
  }
});

// Handle preflight OPTIONS request for CORS
router.options('/proxy-image', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.sendStatus(200);
});

// Simple public test endpoint (no auth required)
router.get('/test-public', (req, res) => {
  res.json({
    success: true,
    message: 'Public test endpoint working!',
    timestamp: new Date().toISOString(),
    note: 'Use this to verify the server is running'
  });
});

// Debug authentication status endpoint
router.get('/debug/auth-status', async (req, res) => {
  try {
    res.json({
      success: true,
      authStatus: {
        hasUser: !!req.user,
        hasUserId: !!req.user?.userId,
        hasBusinessToken: !!req.businessToken,
        hasBusinessOAuth2Client: !!req.businessOAuth2Client,
        
        // Show first few characters for debugging (don't expose full tokens)
        businessTokenPreview: req.businessToken ? `${req.businessToken.substring(0, 10)}...` : null,
        userIdPreview: req.user?.userId || null
      },
      message: 'Authentication status check completed'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to check auth status',
      details: error.message
    });
  }
});

module.exports = router;