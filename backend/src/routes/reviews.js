const express = require('express');
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

// Initialize Supabase client with service role for server-side operations
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// User authentication applies to every review route.
// Business (GMB) authentication is applied PER-ROUTE so that endpoints which
// don't actually call Google APIs (e.g. AI generation from a stored review)
// don't get blocked when a user's GMB token is revoked or expired.
router.use(authMiddleware);

const { tryWithEachBusinessToken } = require('../utils/businessTokens');

// Helper function to save review to database
const saveReviewToDatabase = async (userId, reviewData) => {
  try {
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

    const { data, error } = await supabase
      .from('gmb_reviews')
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

// Helper function to save existing reviews from API to database
const saveExistingReviewsToDatabase = async (userId, reviews, locationId, accountId, platform = 'google') => {
  try {
    // Check if location exists, if not create it
    let { data: existingLocation } = await supabase
      .from('gmb_locations')
      .select('location_id')
      .eq('location_id', locationId)
      .single();

    if (!existingLocation) {
      // Use the specific account ID from the request

      // Verify the account exists (it should have been created by the /accounts endpoint)

      const { data: gmbAccount, error: accountError } = await supabase
        .from('gmb_accounts')
        .select('account_id')
        .eq('account_id', accountId)
        .eq('user_id', userId)
        .single();


      if (!gmbAccount) {

        // Debug: Let's see what accounts DO exist for this user
        const { data: allUserAccounts } = await supabase
          .from('gmb_accounts')
          .select('account_id')
          .eq('user_id', userId);

        return [];
      }

      // Create the location
      const { data: newLocation, error: locationError } = await supabase
        .from('gmb_locations')
        .insert({
          user_id: userId,
          account_id: accountId,
          location_id: locationId,
          location_name: `GMB Location ${locationId}`,
          address: 'Google My Business Location'
        })
        .select()
        .single();

      if (locationError) {
        return [];
      }

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
      const { data: existingReview } = await supabase
        .from('gmb_reviews')
        .select('id')
        .eq('review_id', reviewData.gmbReviewId)
        .single();

      if (existingReview) {
        continue;
      }

      // Save to database
      const savedReview = await saveReviewToDatabase(userId, reviewData);
      if (savedReview) {
        savedReviews.push(savedReview);
      }
    }

    return savedReviews;
  } catch (error) {
    return [];
  }
};

// Helper function to get cached reviews from database
async function getCachedReviews(locationId, userId) {
  try {
    const { data: cachedReviews, error } = await supabase
      .from('gmb_reviews')
      .select('*')
      .eq('location_id', locationId)
      .eq('user_id', userId)
      .order('create_time', { ascending: false });

    if (error) {
      return [];
    }

    return cachedReviews || [];
  } catch (error) {
    return [];
  }
}

// Get reviews for a location
router.get('/accounts/:accountId/locations/:locationId/reviews', requireBusinessAuth, async (req, res) => {
  try {
    const { accountId, locationId } = req.params;
    const { cached_only } = req.query;
    const userId = req.user?.userId;

    // If cached_only=true, return only cached data
    if (cached_only === 'true') {
      const cachedReviews = await getCachedReviews(locationId, userId);
      
      
      return res.json({
        success: true,
        reviews: cachedReviews,
        cached: true,
        message: `Found ${cachedReviews.length} cached reviews`
      });
    }
    
    const axios = require('axios');
    const gmbUrl = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`;

    // Try each connected profile's token until one returns reviews for this location.
    const attempt = await tryWithEachBusinessToken(userId, req.businessToken, async (accessToken) => {
      const r = await axios.get(gmbUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
      });
      return r.data;
    });

    if (!attempt.ok) {
      if (attempt.allUnauthorized) {
        // No connected profile has access — return empty list rather than 404 the UI.
        return res.json({ success: true, reviews: [], cached: false, source: 'GMB_V4_API', note: 'No connected Google profile has access to this location' });
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch reviews from GMB API',
        details: attempt.error?.message
      });
    }

    const data = attempt.result;

    // Save reviews to database
    if (data.reviews && data.reviews.length > 0) {
      await saveExistingReviewsToDatabase(
        req.user.userId,
        data.reviews,
        locationId,
        accountId,
        'google'
      );
    }

    res.json({
      success: true,
      reviews: data.reviews || [],
      cached: false,
      source: 'GMB_V4_API'
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to fetch reviews',
      details: error.message 
    });
  }
});

// Get a specific review
router.get('/accounts/:accountId/locations/:locationId/reviews/:reviewId', requireBusinessAuth, async (req, res) => {
  try {
    let { accountId, locationId, reviewId } = req.params;
    
    // Remove prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    reviewId = reviewId.replace('reviews/', '');
    
    try {
      const axios = require('axios');
      const reviewResponse = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}`,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
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
      res.status(404).json({
        success: false,
        error: 'Review not found or GMB V4 API not available',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch specific review',
      details: error.message
    });
  }
});

// Get reviews from multiple locations
router.post('/accounts/:accountId/locations/batchGetReviews', requireBusinessAuth, async (req, res) => {
  try {
    let { accountId } = req.params;
    const { locationNames, pageSize, pageToken, orderBy, ignoreRatingOnlyReviews } = req.body;
    
    // Remove "accounts/" prefix if present
    accountId = accountId.replace('accounts/', '');
    
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
            'Authorization': `Bearer ${req.businessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      res.json({
        success: true,
        reviews: batchResponse.data.reviews || [],
        nextPageToken: batchResponse.data.nextPageToken,
        totalCount: batchResponse.data.reviews?.length || 0
      });
      
    } catch (gmbV4Error) {
      res.status(400).json({
        success: false,
        error: 'Batch reviews not available - GMB V4 API access required',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch batch reviews',
      details: error.message
    });
  }
});

// Reply to a review
router.put('/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply', requireBusinessAuth, [
  body('comment').notEmpty().withMessage('Comment is required for review reply')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Comment is required for review reply',
      errors: errors.array()
    });
  }

  try {
    let { accountId, locationId, reviewId } = req.params;
    const { comment } = req.body;
    
    // Remove prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    reviewId = reviewId.replace('reviews/', '');
    
    try {
      const axios = require('axios');
      const replyResponse = await axios.put(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`,
        { comment },
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
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
      res.status(400).json({
        success: false,
        error: 'Review reply not available - GMB V4 API access required',
        message: 'This feature requires Google My Business API v4 access',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Failed to reply to review',
      details: error.message
    });
  }
});

// Delete a review reply
router.delete('/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply', requireBusinessAuth, async (req, res) => {
  try {
    let { accountId, locationId, reviewId } = req.params;
    
    // Remove prefixes if present
    accountId = accountId.replace('accounts/', '');
    locationId = locationId.replace('locations/', '');
    reviewId = reviewId.replace('reviews/', '');
    
    try {
      const axios = require('axios');
      await axios.delete(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      res.json({
        success: true,
        message: 'Review reply deleted successfully'
      });
      
    } catch (gmbV4Error) {
      res.status(400).json({
        success: false,
        error: 'Review reply deletion not available - GMB V4 API access required',
        message: 'This feature requires Google My Business API v4 access',
        details: gmbV4Error.message
      });
    }
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete review reply',
      details: error.message
    });
  }
});

// ---------------------------------------------------------------------------
// AI: Generate social/GMB post draft from a stored review.
// Loads the review by gmb_reviews.id (UUID) OR by gmb_reviews.review_id (string),
// then delegates to the shared handler in routes/ai.js. Saves draft to
// ai_generated_posts and logs the job in ai_jobs.
// ---------------------------------------------------------------------------
const { generateReviewPostHandler } = require('./ai');

router.post('/:reviewId/generate-post', async (req, res) => {
  try {
    const userId = req.user.userId;
    const reviewIdParam = req.params.reviewId;

    // Try lookup by UUID primary key first, then by GMB review_id string.
    let review = null;
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reviewIdParam);
    if (uuidLike) {
      const { data } = await supabase
        .from('gmb_reviews')
        .select('*')
        .eq('id', reviewIdParam)
        .eq('user_id', userId)
        .single();
      review = data;
    }
    if (!review) {
      const { data } = await supabase
        .from('gmb_reviews')
        .select('*')
        .eq('review_id', reviewIdParam)
        .eq('user_id', userId)
        .single();
      review = data;
    }

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Optional location → business_name lookup (best-effort).
    let businessName = req.body.businessName || null;
    let city = req.body.city || null;
    if (review.location_id && (!businessName || !city)) {
      const { data: location } = await supabase
        .from('gmb_locations')
        .select('business_name, location_name, address')
        .eq('location_id', review.location_id)
        .eq('user_id', userId)
        .single();
      if (location) {
        if (!businessName) businessName = location.business_name || location.location_name || null;
        if (!city && location.address) {
          // Address is a free-form string; we don't parse it here. Caller can pass city explicitly.
        }
      }
    }

    // Build req.body that generateReviewPostHandler expects.
    req.body = {
      ...req.body,
      businessName: businessName || req.body.businessName,
      businessType: req.body.businessType,
      city: city || req.body.city,
      reviewText: req.body.reviewText || review.comment || '',
      reviewRating: req.body.reviewRating ?? review.star_rating ?? null,
      reviewerName: req.body.reviewerName || review.reviewer_name || '',
      platform: req.body.platform || 'google',
      tone: req.body.tone
    };

    return generateReviewPostHandler(req, res, {
      sourceType: 'review',
      sourceId: review.id
    });
  } catch (err) {
    console.error('reviews/:reviewId/generate-post failed:', err.message);
    return res.status(500).json({ error: 'Failed to generate review post', message: err.message });
  }
});

module.exports = router;
