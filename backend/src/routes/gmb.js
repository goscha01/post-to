const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { google } = require('googleapis');



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
    const readMask = 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels';
    
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
      labels: location.labels
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
    
    // Use Google Business Profile API for reviews
    const businessProfileClient = getBusinessProfileClient(accessToken);
    
    // Note: Reviews are not directly available in Business Profile API v1
    // We'll return an empty array for now
    console.log('Reviews endpoint not available in Business Profile API v1');
    
    return res.json({
      success: true,
      reviews: [],
      message: 'Reviews endpoint not available in Business Profile API v1'
    });
    
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
    
    res.json({
      success: true,
      reviews: reviews
    });
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
      
      console.log('Posts response:', JSON.stringify(postsResponse.data, null, 2));
      
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
      
      res.json({
        success: true,
        posts: posts
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
    console.log('Post data:', JSON.stringify(req.body, null, 2));
    
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
      
      console.log('Final post data:', JSON.stringify(postData, null, 2));
      
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
      
      console.log('Post creation response:', JSON.stringify(createResponse.data, null, 2));
      
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
      
      res.json({
        success: true,
        message: 'Post created successfully on Google My Business',
        post: createdPost
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
        readMask: 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels'
      });
      
      console.log('Locations response:', JSON.stringify(locationsResponse.data, null, 2));
      
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
      
      // Check if there are other media fields in the location data
      console.log('Location data for media extraction:', JSON.stringify({
        profile: location?.profile,
        metadata: location?.metadata,
        hasProfileImage: !!location?.profile?.profileImageUri,
        hasLogoUri: !!location?.metadata?.logoUri,
        hasCoverPhotoUri: !!location?.metadata?.coverPhotoUri,
        hasPhotos: !!location?.photos,
        allProfileKeys: location?.profile ? Object.keys(location.profile) : [],
        allMetadataKeys: location?.metadata ? Object.keys(location.metadata) : [],
        allLocationKeys: Object.keys(location || {})
      }, null, 2));
      
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
        
        console.log('GMB V4 API response:', JSON.stringify(mediaV4Response.data, null, 2));
        
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
          console.log('GMB V4 API error response:', JSON.stringify(gmbV4Error.response.data, null, 2));
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
          
          console.log('Places API response:', JSON.stringify(placeResponse.data, null, 2));
          
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
          console.log('Found Drive files:', JSON.stringify(driveResponse.data.files, null, 2));
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
          console.log('Drive API error response:', JSON.stringify(driveError.response.data, null, 2));
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
        console.log('Performance API response:', performanceResponse.data);
      } catch (performanceError) {
        console.log('Performance API not available:', performanceError.message);
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
    note: 'Posts and media now use GMB V4 API directly via HTTP requests'
  });
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

module.exports = router;
