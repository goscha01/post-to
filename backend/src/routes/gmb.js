const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

// Get GMB accounts
router.get('/accounts', auth, async (req, res) => {
  try {
    const { accessToken } = req.user;
    const gmbClient = getGmbAccountClient(accessToken);
    
    // Get accounts list
    const accountsResponse = await gmbClient.accounts.list();
    
    if (!accountsResponse.data.accounts) {
      return res.json({
        success: true,
        accounts: []
      });
    }
    
    // Format the accounts data
    const accounts = accountsResponse.data.accounts.map(account => ({
      name: account.name,
      accountName: account.accountName,
      accountNumber: account.accountNumber,
      type: account.type,
      role: account.role,
      state: account.state,
      permissionLevel: account.permissionLevel
    }));
    
    res.json({
      success: true,
      accounts: accounts
    });
  } catch (error) {
    console.error('Error fetching GMB accounts:', error);
    
    // If it's an API error, provide more details
    if (error.response && error.response.data) {
      console.error('Google API Error:', JSON.stringify(error.response.data, null, 2));
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch GMB accounts',
      details: error.message,
      apiError: error.response?.data
    });
  }
});

// Get locations for a specific account
router.get('/accounts/:accountId/locations', auth, async (req, res) => {
  try {
    let { accountId } = req.params;
    const { accessToken } = req.user;
    const gmbClient = getBusinessProfileClient(accessToken);
    
    // Remove "accounts/" prefix if present
    accountId = accountId.replace('accounts/', '');
    
    // Construct the proper account name format
    const accountName = `accounts/${accountId}`;
    
    console.log(`Fetching locations for account: ${accountName}`);
    
    // Use only valid, proven working fields in readMask
    const readMask = 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels,serviceArea,categories';
    
    // Get locations for the account with correct readMask parameter
    const locationsResponse = await gmbClient.accounts.locations.list({
      parent: accountName,
      readMask: readMask
    });
    
    console.log('Locations response:', JSON.stringify(locationsResponse.data, null, 2));
    
    if (!locationsResponse.data.locations) {
      return res.json({
        success: true,
        locations: []
      });
    }
    
    // Format the locations data using correct field names
    const locations = locationsResponse.data.locations.map(location => ({
      name: location.name,
      locationName: location.title || location.locationName,
      storeCode: location.storeCode,
      address: location.storefrontAddress,
      phoneNumbers: location.phoneNumbers,
      websiteUri: location.websiteUri,
      profile: location.profile,
      regularHours: location.regularHours,
      metadata: location.metadata,
      latlng: location.latlng,
      openInfo: location.openInfo,
      labels: location.labels,
      serviceArea: location.serviceArea,
      categories: location.categories
    }));
    
    res.json({
      success: true,
      locations: locations
    });
  } catch (error) {
    console.error('Error fetching GMB locations:', error);
    
    // If it's an API error, provide more details
    if (error.response && error.response.data) {
      console.error('Full error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch GMB locations',
      details: error.message,
      apiError: error.response?.data
    });
  }
});

// Get reviews for a specific location using Google My Business API v4
router.get('/accounts/:accountId/locations/:locationId/reviews', auth, async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    const { accessToken } = req.user;
    
    // Remove "accounts/" and "locations/" prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    
    console.log(`Fetching reviews for location: ${locationId} in account: ${accountId}`);
    
    // Try to access Google My Business API v4 directly via HTTP request for reviews
    try {
      console.log('Attempting to access GMB V4 API for reviews...');
      const axios = require('axios');
      const reviewsResponse = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('Reviews response:', JSON.stringify(reviewsResponse.data, null, 2));
      
      if (!reviewsResponse.data.reviews) {
        return res.json({
          success: true,
          reviews: []
        });
      }
      
      // Format the reviews data
      const reviews = reviewsResponse.data.reviews.map(review => ({
        name: review.name,
        reviewId: review.name.split('/').pop(),
        reviewer: review.reviewer,
        starRating: review.starRating,
        comment: review.comment,
        createTime: review.createTime,
        updateTime: review.updateTime,
        reviewReply: review.reviewReply
      }));
      
      // Save reviews to database
      const savedReviews = await saveExistingReviewsToDatabase(req.user.userId, reviews, locationId, 'google');
      console.log(`Saved ${savedReviews.length} reviews to database`);
      
      res.json({
        success: true,
        reviews: reviews,
        savedToDatabase: savedReviews.length
      });
      
    } catch (gmbV4Error) {
      console.log('GMB V4 API for reviews not available:', gmbV4Error.message);
      if (gmbV4Error.response) {
        console.log('GMB V4 API error response:', JSON.stringify(gmbV4Error.response.data, null, 2));
      }
      
      // Fallback to empty reviews if GMB V4 API is not available
      console.log('GMB V4 API failed, trying alternative approaches...');
      
      // Try to get reviews from Business Profile API v1 if available
      try {
        const businessProfileResponse = await gmbClient.accounts.locations.list({
          parent: `accounts/${accountId}`,
          readMask: 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels,reviews'
        });
        
        if (businessProfileResponse.data.locations) {
          const location = businessProfileResponse.data.locations.find(loc => 
            loc.name === `accounts/${accountId}/locations/${locationId}`
          );
          
          if (location?.reviews && location.reviews.length > 0) {
            console.log('Found reviews in Business Profile API:', location.reviews.length);
            const reviews = location.reviews.map(review => ({
              name: review.name,
              reviewId: review.name?.split('/').pop() || 'unknown',
              reviewer: { displayName: review.reviewerName || 'Anonymous' },
              starRating: review.rating || 0,
              comment: review.comment || '',
              createTime: review.createTime || new Date().toISOString(),
              updateTime: review.updateTime || new Date().toISOString(),
              reviewReply: review.reply ? { comment: review.reply, updateTime: review.replyTime } : null
            }));
            
            // Save reviews to database
            const savedReviews = await saveExistingReviewsToDatabase(req.user.userId, reviews, locationId, 'google');
            console.log(`Saved ${savedReviews.length} reviews to database`);
            
            return res.json({
              success: true,
              reviews: reviews,
              message: `Found ${reviews.length} reviews from Business Profile API`,
              source: 'business_profile_v1',
              savedToDatabase: savedReviews.length
            });
          }
        }
      } catch (businessProfileError) {
        console.log('Business Profile API reviews not available:', businessProfileError.message);
      }
      
      // Try to get reviews from Google Places API if we have a place ID
      try {
        if (location?.metadata?.placeId) {
          console.log('Trying Places API for reviews...');
          const placesClient = getPlacesClient(accessToken);
          const placeResponse = await placesClient.places.get({
            name: `places/${location.metadata.placeId}`,
            fields: 'reviews,rating,userRatingCount'
          });
          
          if (placeResponse.data.reviews && placeResponse.data.reviews.length > 0) {
            console.log('Found reviews in Places API:', placeResponse.data.reviews.length);
            const reviews = placeResponse.data.reviews.map(review => ({
              name: `places/${location.metadata.placeId}/review/${review.time}`,
              reviewId: review.time?.toString() || 'unknown',
              reviewer: { displayName: review.authorName || 'Anonymous' },
              starRating: review.rating || 0,
              comment: review.text || '',
              createTime: new Date(review.time * 1000).toISOString(),
              updateTime: new Date(review.time * 1000).toISOString(),
              reviewReply: null // Places API doesn't have business replies
            }));
            
            // Save reviews to database
            const savedReviews = await saveExistingReviewsToDatabase(req.user.userId, reviews, locationId, 'google');
            console.log(`Saved ${savedReviews.length} reviews to database`);
            
            return res.json({
              success: true,
              reviews: reviews,
              message: `Found ${reviews.length} reviews from Places API`,
              source: 'places_api',
              savedToDatabase: savedReviews.length
            });
          }
        }
      } catch (placesError) {
        console.log('Places API reviews not available:', placesError.message);
      }
      
      // If all else fails, return empty reviews with explanation
      res.json({
        success: true,
        reviews: [],
        message: 'No reviews available - GMB V4 API access required. Please check Google Cloud Console to enable the Google My Business API.',
        debug: {
          gmbV4Error: gmbV4Error.message,
          businessProfileAvailable: false,
          placesAvailable: false,
          suggestion: 'Enable Google My Business API v4 in Google Cloud Console or check OAuth scopes'
        }
      });
    }
  } catch (error) {
    console.error('Error fetching reviews:', error);
    
    if (error.response && error.response.data) {
      console.error('Full error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch reviews',
      details: error.message,
      apiError: error.response?.data
    });
  }
});

// Get a specific review
router.get('/accounts/:accountId/locations/:locationId/reviews/:reviewId', auth, async (req, res) => {
  try {
    let { accountId, locationId, reviewId } = req.params;
    const { accessToken } = req.user;
    
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
            'Authorization': `Bearer ${accessToken}`,
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

// Get reviews from multiple locations
router.post('/accounts/:accountId/locations/batchGetReviews', auth, async (req, res) => {
  try {
    let { accountId } = req.params;
    const { accessToken } = req.user;
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
            'Authorization': `Bearer ${accessToken}`,
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
router.get('/accounts/:accountId/locations/:locationId/posts', auth, async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    const { accessToken } = req.user;
    
    // Remove "accounts/" and "locations/" prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    
    console.log(`Fetching posts for location: ${locationId} in account: ${accountId}`);
    
    // Try to access Google My Business API v4 directly via HTTP request for posts
    try {
      console.log('Attempting to access GMB V4 API for posts...');
      const axios = require('axios');
      const postsResponse = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/localPosts`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('Posts response - Posts found:', postsResponse.data.localPosts?.length || 0);
      
      if (!postsResponse.data.localPosts) {
        return res.json({
          success: true,
          posts: []
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
        media: post.media
      }));
      
      // Save existing posts to database
      const savedPosts = await saveExistingPostsToDatabase(req.user.userId, posts, 'google');
      console.log(`Saved ${savedPosts.length} posts to database`);
      
      res.json({
        success: true,
        posts: posts,
        savedToDatabase: savedPosts.length
      });
      
    } catch (gmbV4Error) {
      console.log('GMB V4 API for posts not available:', gmbV4Error.message);
      if (gmbV4Error.response) {
        console.log('GMB V4 API error response:', JSON.stringify(gmbV4Error.response.data, null, 2));
      }
      
      // Fallback to empty posts if GMB V4 API is not available
      res.json({
        success: true,
        posts: [],
        message: 'Posts not available - GMB V4 API access required'
      });
    }
  } catch (error) {
    console.error('Error fetching posts:', error);
    
    if (error.response && error.response.data) {
      console.error('Full error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch posts',
      details: error.message,
      apiError: error.response?.data
    });
  }
});

// Create a new Google My Business post
router.post('/accounts/:accountId/locations/:locationId/posts', auth, async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    const { accessToken } = req.user;
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
            'Authorization': `Bearer ${accessToken}`,
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

// Reply to a review
router.put('/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply', auth, async (req, res) => {
  try {
    let { accountId, locationId, reviewId } = req.params;
    const { accessToken } = req.user;
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
            'Authorization': `Bearer ${accessToken}`,
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

// Delete a review reply
router.delete('/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply', auth, async (req, res) => {
  try {
    let { accountId, locationId, reviewId } = req.params;
    const { accessToken } = req.user;
    
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
            'Authorization': `Bearer ${accessToken}`,
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

// Get media (including logos and photos) for a specific location using Business Profile API
router.get('/accounts/:accountId/locations/:locationId/media', auth, async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    const { accessToken } = req.user;
    
    // Remove "accounts/" and "locations/" prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    
    console.log(`Fetching media for location: ${locationId} in account: ${accountId}`);
    
    // Use Business Profile API for media (photos, logos, videos)
    const gmbClient = getBusinessProfileClient(accessToken);
    
    try {
      // Business Profile API v1 doesn't have direct location.get() method
      // We'll use the locations.list() method and filter for the specific location
      const locationsResponse = await gmbClient.accounts.locations.list({
        parent: `accounts/${accountId}`,
        readMask: 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels,serviceArea,categories'
      });
      
      console.log('Locations found:', locationsResponse.data.locations?.length || 0);
      
      // Find the specific location
      const location = locationsResponse.data.locations?.find(loc => 
        loc.name === `accounts/${accountId}/locations/${locationId}`
      );
      
      console.log('Location found:', !!location, 'Name:', location?.title || 'Unknown');
      
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
        console.log('Media endpoint not available:', mediaError.message);
      }
      
      // Try to access Google My Business API v4 directly via HTTP request
      try {
        const axios = require('axios');
        console.log('Attempting to access GMB V4 API directly...');
        const mediaV4Response = await axios.get(
          `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/media`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        console.log('GMB V4 API media response - Items found:', mediaV4Response.data.mediaItems?.length || 0);
        
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
        console.log('GMB V4 API not available:', gmbV4Error.message);
        if (gmbV4Error.response) {
          console.log('GMB V4 API error status:', gmbV4Error.response.status, 'Error:', gmbV4Error.response.data?.error?.message || 'Unknown error');
        }
      }
      
      // Try to get media from Places API if we have a place ID
      if (location?.metadata?.placeId) {
        try {
          console.log('Attempting to access Places API for place ID:', location.metadata.placeId);
          const placesClient = getPlacesClient(accessToken);
          const placeResponse = await placesClient.places.get({
            name: `places/${location.metadata.placeId}`,
            fields: 'photos,editorialSummary,priceLevel,rating,userRatingCount,websiteUri,formattedPhoneNumber,internationalPhoneNumber'
          });
          
          console.log('Places API response - Photos found:', placeResponse.data.photos?.length || 0);
          
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
          console.log('Places API not available:', placesError.message);
          if (placesError.response) {
            console.log('Places API error response:', JSON.stringify(placesError.response.data, null, 2));
          }
          // Places API might not be enabled or available, continue without it
        }
      }
      
      // Try to get media from Google Drive (business-related images)
      try {
        console.log('Attempting to search Google Drive for business media...');
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
          console.log('Found Drive files:', driveResponse.data.files?.length || 0);
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
        console.log('Google Drive API not available:', driveError.message);
        if (driveError.response) {
          console.log('Drive API error status:', driveError.response.status, 'Error:', driveError.response.data?.error?.message || 'Unknown error');
        }
      }
      
      // Try to get media from Business Profile Performance API
      try {
        const performanceClient = google.businessprofileperformance({
          version: 'v1',
          auth: new google.auth.OAuth2().setCredentials({ access_token: accessToken })
        });
        
        const performanceResponse = await performanceClient.locations.searchkeywords.impressions.monthly.list({
          location: `accounts/${accountId}/locations/${locationId}`
        });
        
        // This API doesn't provide media, but we can log it for debugging
        console.log('Performance API accessed successfully');
      } catch (performanceError) {
        console.log('Performance API not available:', performanceError.message);
      }
      
      // Categorize media items
      const logos = mediaItems.filter(item => item.category === 'LOGO' || item.category === 'PROFILE');
      const photos = mediaItems.filter(item => item.category === 'PHOTO' || item.category === 'COVER' || item.category === 'PLACE_PHOTO');
      const businessImages = mediaItems.filter(item => item.category === 'BUSINESS_IMAGE' || item.source === 'GOOGLE_DRIVE');
      const allMedia = [...logos, ...photos, ...businessImages];
      
      console.log('=== MEDIA SUMMARY ===');
      console.log('Total media items:', mediaItems.length);
      console.log('Logos:', logos.length);
      console.log('Photos:', photos.length);
      console.log('Business images:', businessImages.length);
      console.log('Sources - Business Profile:', logos.length + photos.length, 'GMB V4:', mediaItems.filter(item => item.source === 'GMB_V4_API').length, 'Places:', mediaItems.filter(item => item.category === 'PLACE_PHOTO').length, 'Drive:', mediaItems.filter(item => item.source === 'GOOGLE_DRIVE').length);
      console.log('=====================');
      
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
      console.error('Business Profile API error:', apiError);
      
      // If the location endpoint fails, return empty results
      console.log('Location endpoint not available, returning empty results');
      res.json({
        success: true,
        media: [],
        logos: [],
        message: 'Location endpoint not available'
      });
    }
  } catch (error) {
    console.error('Error fetching media:', error);
    
    if (error.response && error.response.data) {
      console.error('Full error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch media',
      details: error.message,
      apiError: error.response?.data
    });
  }
});

// Get predefined services by category name
router.get('/categories', auth, async (req, res) => {
  try {
    const { regionCode = 'US', languageCode = 'en', filter, view = 'FULL' } = req.query;
    const { accessToken } = req.user;
    
    const gmbClient = getBusinessProfileClient(accessToken);
    
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
router.get('/categories/batchGet', auth, async (req, res) => {
  try {
    const { regionCode = 'US', languageCode = 'en', names, view = 'FULL' } = req.query;
    const { accessToken } = req.user;
    
    if (!names) {
      return res.status(400).json({
        success: false,
        error: 'Category names are required'
      });
    }
    
    const gmbClient = getBusinessProfileClient(accessToken);
    
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
router.get('/locations/:locationId/services', auth, async (req, res) => {
  try {
    const { locationId } = req.params;
    const { accessToken } = req.user;
    
    const gmbClient = getBusinessProfileClient(accessToken);
    
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
router.patch('/locations/:locationId/services', auth, async (req, res) => {
  try {
    const { locationId } = req.params;
    const { serviceItems } = req.body;
    const { accessToken } = req.user;
    
    console.log('Backend: Updating services for location:', locationId);
    console.log('Backend: Service items received:', JSON.stringify(serviceItems, null, 2));
    
    if (!serviceItems || !Array.isArray(serviceItems)) {
      return res.status(400).json({
        success: false,
        error: 'Service items array is required'
      });
    }
    
    const gmbClient = getBusinessProfileClient(accessToken);
    
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

// Get account details
router.get('/accounts/:accountId', auth, async (req, res) => {
  try {
    let { accountId } = req.params;
    const { accessToken } = req.user;
    const gmbClient = getGmbAccountClient(accessToken);
    
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
router.put('/accounts/:accountId', auth, async (req, res) => {
  try {
    let { accountId } = req.params;
    const updateData = req.body;
    const { accessToken } = req.user;
    const gmbClient = getGmbAccountClient(accessToken);
    
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

// Get insights for an account
router.get('/accounts/:accountId/insights', auth, async (req, res) => {
  try {
    let { accountId } = req.params;
    const { startDate, endDate, locationNames } = req.query;
    const { accessToken } = req.user;
    
    // Remove "accounts/" prefix if present
    accountId = accountId.replace('accounts/', '');
    
    // For insights, we need to use the Business Profile API
    // Note: Insights are not directly available in Business Profile API v1
    // We'll return a placeholder response for now
    console.log('Insights endpoint not available in Business Profile API v1');
    
    res.json({
      success: true,
      insights: {
        message: 'Insights endpoint not available in Business Profile API v1',
        note: 'This feature requires additional API access or different API version'
      }
    });
  } catch (error) {
    console.error('Error fetching GMB insights:', error);
    
    if (error.response && error.response.data) {
      console.error('Full error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch GMB insights',
      details: error.message,
      apiError: error.response?.data
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
      'media-v4': 'GET /api/gmb/accounts/:accountId/locations/:locationId/media-v4',
      'media-item': 'GET /api/gmb/accounts/:accountId/locations/:locationId/media/:mediaId'
    },
    testData: {
      accountId: '109194636448236279020',
      locationId: '2141374650782668963'
    },
    note: 'Posts and media now use GMB V4 API directly via HTTP requests',
    troubleshooting: {
      reviews: 'If reviews are empty, check Google Cloud Console to enable Google My Business API v4',
      oauth: 'Ensure OAuth scopes include https://www.googleapis.com/auth/business.manage',
      apis: 'Enable these APIs: Google My Business API, Business Profile API, Places API'
    }
  });
});

// API Status Check endpoint
router.get('/api-status', auth, async (req, res) => {
  try {
    const { accessToken } = req.user;
    
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
      const businessProfileClient = getBusinessProfileClient(accessToken);
      await businessProfileClient.accounts.list();
      status.businessProfile = true;
    } catch (error) {
      status.errors.push(`Business Profile API: ${error.message}`);
    }
    
    try {
      // Test GMB V4 API
      const axios = require('axios');
      await axios.get('https://mybusiness.googleapis.com/v4/accounts', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      status.gmbV4 = true;
    } catch (error) {
      status.errors.push(`GMB V4 API: ${error.response?.status || 'No response'} - ${error.message}`);
    }
    
    try {
      // Test Places API
      const placesClient = getPlacesClient(accessToken);
      await placesClient.places.get({ name: 'places/ChIJN1t_tDeuEmsRUsoyG83frY4' });
      status.places = true;
    } catch (error) {
      status.errors.push(`Places API: ${error.message}`);
    }
    
    try {
      // Test Drive API
      const driveClient = getDriveClient(accessToken);
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
router.get('/accounts/:accountId/locations/:locationId/media-v4', auth, async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    const { accessToken } = req.user;
    
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
            'Authorization': `Bearer ${accessToken}`,
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
router.get('/accounts/:accountId/locations/:locationId/media/:mediaId', auth, async (req, res) => {
  try {
    let { accountId, locationId, mediaId } = req.params;
    const { accessToken } = req.user;
    
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
            'Authorization': `Bearer ${accessToken}`,
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
router.get('/test-gmb-v4', auth, async (req, res) => {
  try {
    const { accessToken } = req.user;
    
    console.log('Testing GMB V4 API access...');
    
    try {
      const axios = require('axios');
      
      // Test basic GMB V4 API access
      const accountsResponse = await axios.get('https://mybusiness.googleapis.com/v4/accounts', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
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

module.exports = router;
