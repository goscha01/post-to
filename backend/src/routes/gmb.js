const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { google } = require('googleapis');

// Initialize Google My Business API
function getGmbClient(accessToken) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken
  });
  
  return google.mybusinessbusinessinformation({
    version: 'v1',
    auth: oauth2Client
  });
}

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

// Initialize Google My Business API v4 for reviews, media, and posts
function getGmbV4Client(accessToken) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken
  });
  
  return google.mybusiness({
    version: 'v4',
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
    const gmbClient = getGmbClient(accessToken);
    
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
    
    // Use Google My Business API v4 for reviews
    const gmbV4Client = getGmbV4Client(accessToken);
    
    const reviewsResponse = await gmbV4Client.accounts.locations.reviews.list({
      parent: `accounts/${accountId}/locations/${locationId}`
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
    
    // Use Google My Business API v4 for posts (note: being deprecated but still active)
    const gmbV4Client = getGmbV4Client(accessToken);
    
    const postsResponse = await gmbV4Client.accounts.locations.localPosts.list({
      parent: `accounts/${accountId}/locations/${locationId}`
    });
    
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
    
    // Use Google My Business API v4 for creating posts
    const gmbV4Client = getGmbV4Client(accessToken);
    
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
    const createResponse = await gmbV4Client.accounts.locations.localPosts.create({
      parent: `accounts/${accountId}/locations/${locationId}`,
      requestBody: postData
    });
    
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

// Get media (including logos and photos) for a specific location using Google My Business API v4
router.get('/accounts/:accountId/locations/:locationId/media', auth, async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    const { accessToken } = req.user;
    
    // Remove "accounts/" and "locations/" prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    
    console.log(`Fetching media for location: ${locationId} in account: ${accountId}`);
    
    // Use Google My Business API v4 for media (photos, logos, videos)
    const gmbV4Client = getGmbV4Client(accessToken);
    
    const mediaResponse = await gmbV4Client.accounts.locations.media.list({
      parent: `accounts/${accountId}/locations/${locationId}`
    });
    
    console.log('Media response:', JSON.stringify(mediaResponse.data, null, 2));
    
    if (!mediaResponse.data.mediaItems) {
      return res.json({
        success: true,
        media: [],
        logos: []
      });
    }
    
    // Format the media data
    const media = mediaResponse.data.mediaItems.map(item => ({
      name: item.name,
      mediaId: item.name.split('/').pop(),
      googleUrl: item.googleUrl,
      mediaFormat: item.mediaFormat,
      dimensions: item.dimensions,
      attribution: item.attribution,
      locationAssociation: item.locationAssociation
    }));
    
    // Filter for profile images and logos
    const logos = media.filter(item => 
      item.locationAssociation?.category === 'PROFILE' || 
      item.attribution?.profileName?.includes('logo') ||
      item.attribution?.profileName?.includes('profile') ||
      item.attribution?.profileName?.includes('cover')
    );
    
    res.json({
      success: true,
      media: media,
      logos: logos
    });
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
    
    // For insights, we need to use the My Business API v4
    // This is a simplified version - you might need to adjust based on your specific needs
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({
      access_token: accessToken
    });
    
    const mybusinessClient = google.mybusiness({
      version: 'v4',
      auth: oauth2Client
    });
    
    // Get insights data
    const insightsResponse = await mybusinessClient.accounts.locations.reportInsights({
      name: `accounts/${accountId}`,
      requestBody: {
        locationNames: locationNames ? locationNames.split(',') : [],
        basicRequest: {
          metricRequests: [
            { metric: 'QUERIES_DIRECT' },
            { metric: 'QUERIES_INDIRECT' },
            { metric: 'VIEWS_MAPS' },
            { metric: 'VIEWS_SEARCH' },
            { metric: 'ACTIONS_WEBSITE' },
            { metric: 'ACTIONS_PHONE' }
          ],
          timeRange: {
            startTime: startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            endTime: endDate || new Date().toISOString()
          }
        }
      }
    });
    
    res.json({
      success: true,
      insights: insightsResponse.data
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
      media: 'GET /api/gmb/accounts/:accountId/locations/:locationId/media'
    },
    testData: {
      accountId: '109194636448236279020',
      locationId: '2141374650782668963'
    }
  });
});

module.exports = router;
