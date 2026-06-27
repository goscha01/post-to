const express = require('express');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const { getOrDownloadImage } = require('../utils/imageCache');
const { tryWithEachBusinessToken } = require('../utils/businessTokens');
const logger = require('../utils/logger');
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


    // Use cached image system to avoid multiple downloads
    const imageData = await getOrDownloadImage(url);


    res.json({
      success: true,
      dataUrl: imageData.data,
      contentType: imageData.type,
      size: imageData.size
    });
  } catch (error) {
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

    const { data: cachedAccounts, error } = await supabase
      .from('gmb_accounts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      return [];
    }

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
    return [];
  }
}

// Get GMB accounts — aggregates across every business OAuth connection the
// user has made (multi-profile). Falls back to req.businessToken if there are
// no entries in business_profiles (e.g., legacy user pre-migration).
router.get('/accounts', async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { cached_only } = req.query;

    if (cached_only === 'true') {
      const cachedAccounts = await getCachedAccounts(userId);
      return res.json({
        success: true,
        accounts: cachedAccounts,
        cached: true,
        message: `Found ${cachedAccounts.length} cached accounts`
      });
    }

    // Pull every stored business OAuth token for this user.
    const { data: userRow } = await supabase
      .from('users')
      .select('business_profiles')
      .eq('id', userId)
      .single();

    const profiles = Array.isArray(userRow?.business_profiles) && userRow.business_profiles.length > 0
      ? userRow.business_profiles
      : (req.businessToken
          ? [{ access_token: req.businessToken, refresh_token: req.businessRefreshToken }]
          : []);

    if (profiles.length === 0) {
      return res.json({ success: true, accounts: [] });
    }

    // Hit GMB for each token in parallel; tolerate per-profile failures.
    const seen = new Map(); // dedupe by account.name across profiles
    await Promise.all(profiles.map(async (p) => {
      try {
        const gmbClient = getGmbAccountClient(p.access_token);
        const resp = await gmbClient.accounts.list();
        for (const acc of (resp.data.accounts || [])) {
          if (!seen.has(acc.name)) {
            seen.set(acc.name, {
              name: acc.name,
              accountName: acc.accountName,
              accountNumber: acc.accountNumber,
              type: acc.type,
              role: acc.role,
              state: acc.state,
              permissionLevel: acc.permissionLevel,
              connected_via_email: p.business_email || null
            });
          }
        }
      } catch (err) {
        console.error('[gmb/accounts] profile fetch failed for', p.business_email || '(unknown)', err.message);
      }
    }));

    const accounts = Array.from(seen.values());

    // Save accounts to database for caching
    if (userId) {

      for (const account of accounts) {
        try {
          // Clean account name and extract ID properly
          const cleanAccountName = account.name.replace(/^accounts\/accounts\//, 'accounts/');
          const accountId = cleanAccountName.split('/').pop();

          if (account.name !== cleanAccountName) {
          }


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
          } else {
          }
        } catch (dbError) {
        }
      }
    } else {
    }

    res.json({
      success: true,
      accounts: accounts
    });
  } catch (error) {
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

    const { data: cachedLocations, error } = await supabase
      .from('gmb_locations')
      .select('*')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      return [];
    }

    
    return cachedLocations.map(location => {
      const mappedLocation = {
        name: `accounts/${location.account_id}/locations/${location.location_id}`,
        locationName: location.location_name,
        businessName: location.business_name || location.location_name,
        address: location.address ? (() => {
          try {
            return JSON.parse(location.address);
          } catch (parseError) {
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
      
      
      return mappedLocation;
    });
  } catch (error) {
    return [];
  }
}

// Get locations for a specific account — multi-profile aware.
// Tries every stored OAuth token until one returns locations for this account.
router.get('/accounts/:accountId/locations', async (req, res) => {
  try {
    let { accountId } = req.params;
    const userId = req.user?.userId;
    const { cached_only } = req.query;

    accountId = accountId.replace('accounts/', '');

    if (cached_only === 'true') {
      const cachedLocations = await getCachedLocations(accountId, userId);
      return res.json({
        success: true,
        locations: cachedLocations,
        cached: true,
        message: `Found ${cachedLocations.length} cached locations`
      });
    }

    const accountName = `accounts/${accountId}`;
    const readMask = 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels,serviceArea,categories';

    const attempt = await tryWithEachBusinessToken(userId, req.businessToken, async (accessToken) => {
      const gmbClient = getBusinessProfileClient(accessToken);
      const r = await gmbClient.accounts.locations.list({ parent: accountName, readMask });
      // No locations from this token? Signal "try next" by returning null.
      if (!r?.data?.locations || r.data.locations.length === 0) return null;
      return r.data.locations;
    });

    if (!attempt.ok) {
      if (attempt.allUnauthorized) {
        // Every token said 401/403/404 — clean up stale rows and return empty.
        if (userId) {
          try {
            await supabase.from('gmb_locations').delete().eq('account_id', accountId).eq('user_id', userId);
            await supabase.from('gmb_accounts').delete().eq('account_id', accountId).eq('user_id', userId);
          } catch (_) { /* ignore */ }
        }
        return res.json({
          success: true,
          locations: [],
          message: 'No connected Google profile has access to this account'
        });
      }
      throw attempt.error || new Error('All business tokens failed');
    }

    // Wrap the locations array into the legacy `locationsResponse` shape so the
    // rest of the handler below doesn't need rewiring.
    const locationsResponse = { data: { locations: attempt.result } };

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

        } catch (dbError) {
          // Ignore database errors for individual locations
        }
      }
    }

    res.json({
      success: true,
      locations: locations
    });
  } catch (error) {
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
      return null;
    }

    return cachedMedia;
  } catch (error) {
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
      return null;
    }

    return data;
  } catch (error) {
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

    logger.info('gmb.media.request', {
      account_id: accountId,
      location_id: locationId,
      user_id: userId,
      cached_only: cached_only === 'true',
    });

    // If cached_only=true, return only cached data
    if (cached_only === 'true') {
      const cachedMedia = await getCachedMedia(accountId, locationId, userId);
      if (cachedMedia) {
        logger.info('gmb.media.cached_hit', {
          account_id: accountId,
          location_id: locationId,
          total_media_count: cachedMedia.total_media_count,
          has_profile_picture: !!cachedMedia.profile_picture,
        });
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
        logger.info('gmb.media.cached_miss', {
          account_id: accountId,
          location_id: locationId,
        });
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

    // Multi-profile: try each connected OAuth token until one returns the
    // location with media URIs populated.
    let tokensTried = 0;
    let tokensWithLocation = 0;
    const mediaAttempt = await tryWithEachBusinessToken(userId, accessToken, async (tok) => {
      tokensTried += 1;
      const gmbClient = getBusinessProfileClient(tok);
      let r;
      try {
        r = await gmbClient.accounts.locations.list({
          parent: `accounts/${accountId}`,
          readMask: 'name,title,storeCode,websiteUri,storefrontAddress,phoneNumbers,profile,regularHours,metadata,latlng,openInfo,labels,serviceArea,categories'
        });
      } catch (err) {
        logger.warn('gmb.media.token_attempt_error', {
          account_id: accountId,
          location_id: locationId,
          token_index: tokensTried,
          error: err?.message,
          status: err?.response?.status ?? null,
        });
        return null;
      }
      // v1 GMB API returns `locations/XXX`; v4 returns `accounts/X/locations/XXX`. Accept either.
      const _target = `locations/${locationId}`;
      const _target2 = `accounts/${accountId}/locations/${locationId}`;
      const loc = r?.data?.locations?.find(l => l.name === _target || l.name === _target2 || l.name?.endsWith('/' + _target));
      if (!loc) {
        logger.info('gmb.media.token_attempt_miss', {
          account_id: accountId,
          location_id: locationId,
          token_index: tokensTried,
          returned_location_count: r?.data?.locations?.length ?? 0,
          returned_location_names: (r?.data?.locations || []).slice(0, 5).map(l => l.name),
        });
        return null;
      }
      tokensWithLocation += 1;
      return r;
    });

    try {
      if (!mediaAttempt.ok) {
        logger.warn('gmb.media.all_tokens_failed', {
          account_id: accountId,
          location_id: locationId,
          tokens_tried: tokensTried,
        });
        return res.json({ success: true, media: [], logos: [], photos: [], profilePicture: null, message: 'No connected Google profile has media for this location' });
      }
      const locationsResponse = mediaAttempt.result;

      const __target = `locations/${locationId}`;
      const __target2 = `accounts/${accountId}/locations/${locationId}`;
      const location = locationsResponse.data.locations?.find(loc =>
        loc.name === __target || loc.name === __target2 || loc.name?.endsWith('/' + __target)
      );
      
      if (location) {
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

      logger.info('gmb.media.response', {
        account_id: accountId,
        location_id: locationId,
        tokens_tried: tokensTried,
        tokens_with_location: tokensWithLocation,
        media_count: mediaItems.length,
        logo_count: logos.length,
        photo_count: photos.length,
        has_profile_picture: !!profilePicture,
        profile_picture_category: profilePicture?.category ?? null,
        profile_picture_url_host: profilePicture?.googleUrl
          ? new URL(profilePicture.googleUrl).hostname
          : null,
        has_profile_uri: !!location?.profile?.profileImageUri,
        has_logo_uri: !!location?.metadata?.logoUri,
        has_cover_uri: !!location?.metadata?.coverPhotoUri,
        raw_photos_count: Array.isArray(location?.photos) ? location.photos.length : 0,
      });

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
      logger.error('gmb.media.api_error', {
        account_id: accountId,
        location_id: locationId,
        error: apiError?.message,
        stack: apiError?.stack?.slice(0, 1500),
      });
      res.json({
        success: true,
        media: [],
        logos: [],
        message: 'Location endpoint not available'
      });
    }
  } catch (error) {
    logger.error('gmb.media.unhandled', {
      account_id: req.params.accountId,
      location_id: req.params.locationId,
      error: error?.message,
      stack: error?.stack?.slice(0, 1500),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch media',
      details: error.message
    });
  }
});

module.exports = router;
