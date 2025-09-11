const express = require('express');
const { google } = require('googleapis');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const router = express.Router();

// Apply both middlewares to all GMB routes
router.use(authMiddleware); // First authenticate the user
router.use(requireBusinessAuth); // Then check business authentication

// Mount separate route files
router.use('/insights', require('./insights')); // Mount insights routes
router.use('/posts', require('./posts'));       // Mount posts routes
router.use('/', require('./reviews'));   // Mount reviews routes at root level
router.use('/', require('./services')); // Mount services routes at root level

// Proxy image endpoint for Google Photos URLs (moved from posts.js)
router.get('/proxy-image', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL parameter is required'
      });
    }
    
    // Validate that it's a Google Photos URL
    if (!url.includes('lh3.googleusercontent.com')) {
      return res.status(400).json({
        success: false,
        error: 'Only Google Photos URLs are supported'
      });
    }
    
    // Fetch the image
    const axios = require('axios');
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    // Convert to base64 data URL
    const base64 = Buffer.from(response.data, 'binary').toString('base64');
    const contentType = response.headers['content-type'] || 'image/jpeg';
    const dataUrl = `data:${contentType};base64,${base64}`;
    
    res.json({
      success: true,
      dataUrl: dataUrl,
      contentType: contentType,
      size: response.data.length
    });
    
  } catch (error) {
    console.error('Error proxying image:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to proxy image',
      details: error.message
    });
  }
});

// Initialize Google Business Profile API clients
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

// Get GMB accounts
router.get('/accounts', async (req, res) => {
  try {
    const accessToken = req.businessToken;
    const gmbClient = getGmbAccountClient(accessToken);
    
    const accountsResponse = await gmbClient.accounts.list();
    
    if (!accountsResponse.data.accounts) {
      return res.json({
        success: true,
        accounts: []
      });
    }
    
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
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch GMB accounts',
      details: error.message
    });
  }
});

// Get locations for a specific account
router.get('/accounts/:accountId/locations', async (req, res) => {
  try {
    let { accountId } = req.params;
    const accessToken = req.businessToken;
    const gmbClient = getBusinessProfileClient(accessToken);
    
    accountId = accountId.replace('accounts/', '');
    const accountName = `accounts/${accountId}`;
    
    const readMask = 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels,serviceArea,categories';
    
    const locationsResponse = await gmbClient.accounts.locations.list({
      parent: accountName,
      readMask: readMask
    });
    
    if (!locationsResponse.data.locations) {
      return res.json({
        success: true,
        locations: []
      });
    }
    
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
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch GMB locations',
      details: error.message
    });
  }
});

// Get media for a specific location
router.get('/accounts/:accountId/locations/:locationId/media', async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    const accessToken = req.businessToken;
    
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    
    const gmbClient = getBusinessProfileClient(accessToken);
    
    try {
      const locationsResponse = await gmbClient.accounts.locations.list({
        parent: `accounts/${accountId}`,
        readMask: 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels,serviceArea,categories'
      });
      
      const location = locationsResponse.data.locations?.find(loc => 
        loc.name === `accounts/${accountId}/locations/${locationId}`
      );
      
      console.log(`Media endpoint: Found location for ${accountId}/${locationId}:`, !!location);
      if (location) {
        console.log('Location profile:', location.profile);
        console.log('Location metadata:', location.metadata);
        console.log('Location photos:', location.photos);
      }
      
      let mediaItems = [];
      
      if (location?.profile?.profileImageUri) {
        mediaItems.push({
          name: `locations/${locationId}/profile`,
          mediaId: 'profile',
          googleUrl: location.profile.profileImageUri,
          mediaFormat: 'PHOTO',
          category: 'PROFILE'
        });
      }
      
      if (location?.metadata?.logoUri) {
        mediaItems.push({
          name: `locations/${locationId}/logo`,
          mediaId: 'logo',
          googleUrl: location.metadata.logoUri,
          mediaFormat: 'PHOTO',
          category: 'LOGO'
        });
      }
      
      if (location?.metadata?.coverPhotoUri) {
        mediaItems.push({
          name: `locations/${locationId}/cover`,
          mediaId: 'cover',
          googleUrl: location.metadata.coverPhotoUri,
          mediaFormat: 'PHOTO',
          category: 'COVER'
        });
      }
      
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
      
      const logos = mediaItems.filter(item => item.category === 'LOGO' || item.category === 'PROFILE');
      const photos = mediaItems.filter(item => item.category === 'PHOTO' || item.category === 'COVER');
      
      // Set profile picture (prioritize PROFILE category, then LOGO, then first available)
      let profilePicture = null;
      if (logos.length > 0) {
        const profileMedia = logos.find(item => item.category === 'PROFILE');
        profilePicture = profileMedia || logos[0];
      } else if (mediaItems.length > 0) {
        profilePicture = mediaItems[0];
      }
      
      console.log(`Media endpoint: Found ${mediaItems.length} total media items`);
      console.log(`Media endpoint: Found ${logos.length} logos`);
      console.log(`Media endpoint: Found ${photos.length} photos`);
      console.log(`Media endpoint: Profile picture set to:`, profilePicture);
      
      res.json({
        success: true,
        media: mediaItems,
        logos: logos,
        photos: photos,
        profilePicture: profilePicture,
        message: mediaItems.length > 0 ? `Found ${mediaItems.length} media items` : 'No media available'
      });
      
    } catch (apiError) {
      res.json({
        success: true,
        media: [],
        logos: [],
        message: 'Location endpoint not available'
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

module.exports = router;
