const express = require('express');
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Apply both middlewares to all review routes
router.use(authMiddleware); // First authenticate the user
router.use(requireBusinessAuth); // Then check business authentication

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
      console.error('Error saving review to database:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error in saveReviewToDatabase:', error);
    return null;
  }
};

// Helper function to save existing reviews from API to database
const saveExistingReviewsToDatabase = async (userId, reviews, locationId, platform = 'google') => {
  try {
    // Check if location exists, if not create it
    let { data: existingLocation } = await supabase
      .from('gmb_locations')
      .select('location_id')
      .eq('location_id', locationId)
      .single();

    if (!existingLocation) {
      // Get an existing GMB account to use
      const { data: gmbAccount } = await supabase
        .from('gmb_accounts')
        .select('account_id')
        .limit(1)
        .single();

      if (!gmbAccount) {
        console.log('No GMB account found in database, skipping location creation');
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
    console.error('Error saving existing reviews to database:', error);
    return [];
  }
};

// Get reviews for a location
router.get('/accounts/:accountId/locations/:locationId/reviews', async (req, res) => {
  try {
    const { accountId, locationId } = req.params;
    
    try {
      const axios = require('axios');
      const reviews = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`,
        {
          headers: {
            'Authorization': `Bearer ${req.businessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      // Save existing reviews to database
      if (reviews.data.reviews && reviews.data.reviews.length > 0) {
        await saveExistingReviewsToDatabase(
          req.user.userId, 
          reviews.data.reviews, 
          locationId, 
          'google'
        );
      }
      
      res.json({
        success: true,
        reviews: reviews.data.reviews || [],
        source: 'GMB_V4_API'
      });
      
    } catch (gmbV4Error) {
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

// Get a specific review
router.get('/accounts/:accountId/locations/:locationId/reviews/:reviewId', async (req, res) => {
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
    console.error('Error fetching specific review:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch specific review',
      details: error.message
    });
  }
});

// Get reviews from multiple locations
router.post('/accounts/:accountId/locations/batchGetReviews', async (req, res) => {
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
    console.error('Error fetching batch reviews:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch batch reviews',
      details: error.message
    });
  }
});

// Reply to a review
router.put('/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply', [
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
    console.error('Error replying to review:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to reply to review',
      details: error.message
    });
  }
});

// Delete a review reply
router.delete('/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply', async (req, res) => {
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
    console.error('Error deleting review reply:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete review reply',
      details: error.message
    });
  }
});

module.exports = router;
