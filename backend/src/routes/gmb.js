const express = require('express');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const { getOrDownloadImage } = require('../utils/imageCache');
const router = express.Router();

// Initialize Supabase client with service role for server-side operations
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Proxy image endpoint for Google Photos URLs (only needs basic auth, not business auth)
router.get('/proxy-image', authMiddleware, async (req, res) => {
  try {
    const { url } = req.query;

    console.log(`🖼️ Proxy image request for URL: ${url ? url.substring(0, 50) + '...' : 'null'}`);

    if (!url) {
      console.error('❌ Missing URL parameter');
      return res.status(400).json({
        success: false,
        error: 'URL parameter is required'
      });
    }

    // Validate that it's a Google Photos URL
    if (!url.includes('lh3.googleusercontent.com')) {
      console.error('❌ Invalid URL - not a Google Photos URL:', url);
      return res.status(400).json({
        success: false,
        error: 'Only Google Photos URLs are supported'
      });
    }

    console.log(`🔄 Processing image: ${url.substring(0, 50)}...`);

    // Use cached image system to avoid multiple downloads
    const imageData = await getOrDownloadImage(url);

    console.log(`✅ Image processed successfully: ${imageData.size} bytes, type: ${imageData.type}`);

    res.json({
      success: true,
      dataUrl: imageData.data,
      contentType: imageData.type,
      size: imageData.size
    });
  } catch (error) {
    console.error('❌ Error proxying image:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Failed to proxy image',
      details: error.message
    });
  }
});

// Apply both middlewares to all other GMB routes
router.use(authMiddleware); // First authenticate the user
router.use(requireBusinessAuth); // Then check business authentication

// Mount separate route files
router.use('/insights', require('./insights')); // Mount insights routes
router.use('/posts', require('./posts'));       // Mount posts routes
router.use('/', require('./reviews'));   // Mount reviews routes at root level
router.use('/', require('./services')); // Mount services routes at root level

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

// Helper function to get cached accounts from database
async function getCachedAccounts(userId) {
  try {
    console.log(`🗃️ Looking for cached accounts for user: ${userId}`);

    const { data: cachedAccounts, error } = await supabase
      .from('gmb_accounts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.log('❌ Accounts cache query error:', error);
      return [];
    }

    console.log(`📦 Found ${cachedAccounts.length} cached accounts`);
    return cachedAccounts.map(account => ({
      name: `accounts/${account.account_id}`,
      accountName: account.account_name,
      accountNumber: account.account_id,
      type: account.account_type,
      role: account.role,
      state: account.state,
      permissionLevel: account.permission_level
    }));
  } catch (error) {
    console.error('Error in getCachedAccounts:', error);
    return [];
  }
}

// Get GMB accounts
router.get('/accounts', async (req, res) => {
  try {
    const accessToken = req.businessToken;
    const userId = req.user?.userId;
    const { cached_only } = req.query;

    // If cached_only=true, return only cached data
    if (cached_only === 'true') {
      const cachedAccounts = await getCachedAccounts(userId);
      return res.json({
        success: true,
        accounts: cachedAccounts,
        cached: true,
        message: `Found ${cachedAccounts.length} cached accounts`
      });
    }

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

    // Save accounts to database for caching
    if (userId) {
      console.log(`🔍 Saving ${accounts.length} accounts for user: ${userId}`);

      for (const account of accounts) {
        try {
          // Clean account name and extract ID properly
          const cleanAccountName = account.name.replace(/^accounts\/accounts\//, 'accounts/');
          const accountId = cleanAccountName.split('/').pop();

          if (account.name !== cleanAccountName) {
            console.warn(`🔧 Fixed corrupted account name: "${account.name}" -> "${cleanAccountName}"`);
          }

          console.log(`🔍 Attempting to save account ${accountId} for user ${userId}`);

          // Upsert account to database
          const { data, error } = await supabase
            .from('gmb_accounts')
            .upsert({
              user_id: userId,
              account_id: accountId,
              account_name: account.accountName,
              role: account.role,
              state: account.state,
              account_type: account.type
            }, {
              onConflict: 'user_id,account_id'
            })
            .select();

          if (error) {
            console.error(`❌ Database error saving account ${accountId}:`, error);
          } else {
            console.log(`✅ Saved GMB account to database: ${accountId}`, data);
          }
        } catch (dbError) {
          console.error(`❌ Failed to save account ${account.name} to database:`, dbError);
        }
      }
    } else {
      console.log(`❌ No userId provided, cannot save accounts to database`);
    }

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

// Helper function to get cached locations from database
async function getCachedLocations(accountId, userId) {
  try {
    console.log(`🗃️ Looking for cached locations for account: ${accountId}, user: ${userId}`);

    const { data: cachedLocations, error } = await supabase
      .from('gmb_locations')
      .select('*')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.log('❌ Locations cache query error:', error);
      return [];
    }

    console.log(`📦 Found ${cachedLocations.length} cached locations`);
    console.log(`🔍 [DEBUG] Cached location data from database:`, cachedLocations.map(loc => ({
      location_id: loc.location_id,
      location_name: loc.location_name,
      business_name: loc.business_name,
      allKeys: Object.keys(loc)
    })));
    
    return cachedLocations.map(location => {
      const mappedLocation = {
        name: `accounts/${location.account_id}/locations/${location.location_id}`,
        locationName: location.location_name,
        businessName: location.business_name || location.location_name,
        address: location.address ? (() => {
          try {
            return JSON.parse(location.address);
          } catch (parseError) {
            console.warn(`Invalid JSON in address field for location ${location.location_id}:`, location.address?.substring(0, 50));
            return null;
          }
        })() : null,
        phoneNumbers: location.phone ? [{ phoneNumber: location.phone }] : [],
        websiteUri: location.website_url,
        primaryCategory: location.primary_category,
        additionalCategories: location.additional_categories || [],
        storeCode: location.store_code,
        labels: location.labels || []
      };
      
      console.log(`🔍 [DEBUG] Cached location mapped for ${location.location_name}:`, {
        name: mappedLocation.name,
        locationName: mappedLocation.locationName,
        businessName: mappedLocation.businessName,
        originalBusinessName: location.business_name
      });
      
      return mappedLocation;
    });
  } catch (error) {
    console.error('Error in getCachedLocations:', error);
    return [];
  }
}

// Get locations for a specific account
router.get('/accounts/:accountId/locations', async (req, res) => {
  try {
    let { accountId } = req.params;
    const accessToken = req.businessToken;
    const userId = req.user?.userId;
    const { cached_only } = req.query;

    accountId = accountId.replace('accounts/', '');

    // If cached_only=true, return only cached data
    if (cached_only === 'true') {
      const cachedLocations = await getCachedLocations(accountId, userId);
      return res.json({
        success: true,
        locations: cachedLocations,
        cached: true,
        message: `Found ${cachedLocations.length} cached locations`
      });
    }

    const gmbClient = getBusinessProfileClient(accessToken);
    const accountName = `accounts/${accountId}`;
    
    const readMask = 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels,serviceArea,categories';
    
    const locationsResponse = await gmbClient.accounts.locations.list({
      parent: accountName,
      readMask: readMask
    });
    
    console.log(`🔍 [DEBUG] Raw GMB API response for ${accountId}:`, {
      hasLocations: !!locationsResponse.data.locations,
      locationsCount: locationsResponse.data.locations?.length || 0,
      firstLocation: locationsResponse.data.locations?.[0] ? {
        name: locationsResponse.data.locations[0].name,
        title: locationsResponse.data.locations[0].title,
        profile: locationsResponse.data.locations[0].profile,
        profileBusinessName: locationsResponse.data.locations[0].profile?.businessName,
        allKeys: Object.keys(locationsResponse.data.locations[0])
      } : null
    });
    
    if (!locationsResponse.data.locations) {
      return res.json({
        success: true,
        locations: []
      });
    }
    
    const locations = locationsResponse.data.locations.map(location => {
      const mappedLocation = {
        name: location.name,
        locationName: location.title || location.locationName,
        businessName: location.profile?.businessName || location.title || location.locationName,
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
      };
      
      console.log(`🔍 [DEBUG] Mapped location for ${location.title}:`, {
        name: mappedLocation.name,
        locationName: mappedLocation.locationName,
        businessName: mappedLocation.businessName,
        profileBusinessName: mappedLocation.profile?.businessName,
        hasProfile: !!mappedLocation.profile
      });
      
      return mappedLocation;
    });

    // Save locations to database for caching
    if (userId) {
      for (const location of locations) {
        try {
          const locationId = location.name.split('/').pop();

          // Upsert location to database
          await supabase
            .from('gmb_locations')
            .upsert({
              user_id: userId,
              account_id: accountId,
              location_id: locationId,
              location_name: location.locationName,
              business_name: location.businessName || location.profile?.businessName || location.locationName,
              address: location.address ? JSON.stringify(location.address) : null,
              phone: location.phoneNumbers?.[0]?.phoneNumber || null,
              website_url: location.websiteUri,
              primary_category: location.categories?.[0]?.displayName || null,
              additional_categories: Array.isArray(location.categories) ? location.categories.slice(1).map(cat => cat.displayName) : [],
              store_code: location.storeCode,
              language_code: location.metadata?.languageCode || null,
              labels: location.labels || []
            }, {
              onConflict: 'user_id,account_id,location_id'
            });

          console.log(`✅ Saved GMB location to database: ${locationId}`);
        } catch (dbError) {
          console.error(`❌ Failed to save location ${location.name} to database:`, dbError);
        }
      }
    }

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

// Helper function to get cached media from database
async function getCachedMedia(accountId, locationId, userId) {
  try {
    const { data: cachedMedia, error } = await supabase
      .from('gmb_media_cache')
      .select('*')
      .eq('account_id', accountId)
      .eq('location_id', locationId)
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching cached media:', error);
      return null;
    }

    return cachedMedia;
  } catch (error) {
    console.error('Error in getCachedMedia:', error);
    return null;
  }
}

// Helper function to save media to database cache
async function saveMediaToCache(accountId, locationId, userId, mediaData) {
  try {
    const { data, error } = await supabase
      .from('gmb_media_cache')
      .upsert({
        user_id: userId,
        account_id: accountId,
        location_id: locationId,
        media_data: mediaData.media || [],
        logos: mediaData.logos || [],
        photos: mediaData.photos || [],
        profile_picture: mediaData.profilePicture,
        total_media_count: (mediaData.media || []).length
      }, {
        onConflict: 'user_id,account_id,location_id'
      })
      .select()
      .single();

    if (error) {
      console.error('Error saving media to cache:', error);
      return null;
    }

    console.log(`✅ Saved media to cache: ${accountId}/${locationId}`);
    return data;
  } catch (error) {
    console.error('Error in saveMediaToCache:', error);
    return null;
  }
}

// Get media for a specific location
router.get('/accounts/:accountId/locations/:locationId/media', async (req, res) => {
  try {
    let { accountId, locationId } = req.params;
    const { cached_only } = req.query;
    const accessToken = req.businessToken;
    const userId = req.user?.userId;

    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');

    // If cached_only=true, return only cached data
    if (cached_only === 'true') {
      const cachedMedia = await getCachedMedia(accountId, locationId, userId);
      if (cachedMedia) {
        return res.json({
          success: true,
          media: cachedMedia.media_data,
          logos: cachedMedia.logos,
          photos: cachedMedia.photos,
          profilePicture: cachedMedia.profile_picture,
          cached: true,
          message: `Found ${cachedMedia.total_media_count} cached media items`
        });
      } else {
        return res.json({
          success: true,
          media: [],
          logos: [],
          photos: [],
          profilePicture: null,
          cached: true,
          message: 'No cached media available'
        });
      }
    }

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

      // Save media to cache for future requests
      const mediaResponse = {
        media: mediaItems,
        logos: logos,
        photos: photos,
        profilePicture: profilePicture
      };

      if (userId) {
        await saveMediaToCache(accountId, locationId, userId, mediaResponse);
      }

      res.json({
        success: true,
        media: mediaItems,
        logos: logos,
        photos: photos,
        profilePicture: profilePicture,
        cached: false,
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
