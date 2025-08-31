// Updated insights.js - Fixed API calls for Google Business Profile Performance API
const express = require('express');
const router = express.Router();
const axios = require('axios');

// API URL for Google Business Profile Performance API
const PERFORMANCE_URL = 'https://businessprofileperformance.googleapis.com/v1';

// Get basic insights for a location using Google Business Profile Performance API
router.post('/basic', async (req, res) => {
  try {
    const { accessToken, accountId, locationId, metricRequests, timeRange } = req.body;
    
    console.log('📥 Insights request received for location:', locationId);
    console.log('🔍 Metric requests:', JSON.stringify(metricRequests, null, 2));
    
    if (!accessToken || !locationId || !metricRequests || !timeRange) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: accessToken, locationId, metricRequests, timeRange'
      });
    }

    const startDate = new Date(timeRange.startTime);
    const endDate = new Date(timeRange.endTime);

    // Map dashboard metrics to actual Performance API DailyMetric enum values
    const metricMap = {
      // Aggregated View Metrics (combine desktop + mobile)
      'VIEWS_MAPS': ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
      'VIEWS_SEARCH': ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
      
      // Detailed View Metrics (individual platform metrics)
      'VIEWS_MAPS_DESKTOP': ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS'],
      'VIEWS_MAPS_MOBILE': ['BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
      'VIEWS_SEARCH_DESKTOP': ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'],
      'VIEWS_SEARCH_MOBILE': ['BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
      
      // Action Metrics
      'ACTIONS_PHONE': ['CALL_CLICKS'],
      'ACTIONS_WEBSITE': ['WEBSITE_CLICKS'],
      'ACTIONS_DRIVING_DIRECTIONS': ['BUSINESS_DIRECTION_REQUESTS'],
      
      // Communication Metrics
      'BUSINESS_CONVERSATIONS': ['BUSINESS_CONVERSATIONS'],
      
      // Booking & Order Metrics
      'BUSINESS_BOOKINGS': ['BUSINESS_BOOKINGS'],
      'BUSINESS_FOOD_ORDERS': ['BUSINESS_FOOD_ORDERS'],
      'BUSINESS_FOOD_MENU_CLICKS': ['BUSINESS_FOOD_MENU_CLICKS']
    };

    const allMetricsData = [];
    
    for (const metricRequest of metricRequests) {
      const gmbMetric = metricRequest.metric;
      const apiMetrics = metricMap[gmbMetric] || [gmbMetric];
      
      let totalValue = 0;
      
      // Fetch data for each API metric that maps to this dashboard metric
      for (const apiMetric of apiMetrics) {
        try {
          console.log(`🚀 Making API call for: ${gmbMetric} -> ${apiMetric}`);
          console.log(`📅 Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
          
          const response = await axios.get(
            `${PERFORMANCE_URL}/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
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
          
          console.log(`✅ API response for ${apiMetric}:`, JSON.stringify(response.data, null, 2));
          
          // Sum up values from this API metric
          let metricValue = 0;
          if (response.data.multiDailyMetricTimeSeries) {
            response.data.multiDailyMetricTimeSeries.forEach(metricSeries => {
              if (metricSeries.dailyMetricTimeSeries) {
                metricSeries.dailyMetricTimeSeries.forEach(dailySeries => {
                  if (dailySeries.timeSeries && dailySeries.timeSeries.datedValues) {
                    dailySeries.timeSeries.datedValues.forEach(datedValue => {
                      if (datedValue.value) {
                        const value = parseInt(datedValue.value) || 0;
                        metricValue += value;
                        console.log(`📊 Found value ${value} for ${apiMetric} on ${datedValue.date}`);
                      }
                    });
                  }
                });
              }
            });
          }
          
          console.log(`💰 Total value for ${apiMetric}: ${metricValue}`);
          totalValue += metricValue;
          
        } catch (error) {
          console.error(`❌ Failed to fetch ${apiMetric}:`, error.response?.data || error.message);
          console.error(`❌ Error status:`, error.response?.status);
        }
      }
      
      // Store the aggregated result for this dashboard metric
      console.log(`🎯 Final aggregated value for ${gmbMetric}: ${totalValue}`);
      allMetricsData.push({
        gmbMetric: gmbMetric,
        totalValue: totalValue
      });
    }

    console.log('✅ All metrics fetched successfully');
    
    // Create response in expected format
    const locationMetrics = allMetricsData.map(metricData => ({
      metric: metricData.gmbMetric,
      metricValues: [{
        value: metricData.totalValue.toString(),
        time: new Date().toISOString()
      }]
    }));
    
    const transformedData = { locationMetrics };
    console.log('✨ Final transformed data:', JSON.stringify(transformedData, null, 2));

    res.json({
      success: true,
      data: transformedData
    });

  } catch (error) {
    console.error('🚨 Error fetching basic insights:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch insights',
      message: error.message
    });
  }
});

// Helper function to transform multiple metrics data
function transformMultipleMetricsData(allMetricsData, originalMetrics) {
  try {
    const locationMetrics = [];
    
    for (const metricData of allMetricsData) {
      const { gmbMetric, data } = metricData;
      
      let totalValue = 0;
      
      // Handle the API response structure
      if (data.multiDailyMetricTimeSeries && data.multiDailyMetricTimeSeries.length > 0) {
        const metricSeries = data.multiDailyMetricTimeSeries[0];
        
        if (metricSeries.dailyMetricTimeSeries && metricSeries.dailyMetricTimeSeries.length > 0) {
          const dailySeries = metricSeries.dailyMetricTimeSeries[0];
          
          if (dailySeries.timeSeries && dailySeries.timeSeries.datedValues) {
            dailySeries.timeSeries.datedValues.forEach(datedValue => {
              if (datedValue.value) {
                totalValue += parseInt(datedValue.value) || 0;
              }
            });
          }
        }
      }
      
      locationMetrics.push({
        metric: gmbMetric,
        metricValues: [{
          value: totalValue.toString(),
          time: new Date().toISOString()
        }]
      });
    }
    
    return { locationMetrics };
    
  } catch (error) {
    console.error('🚨 Error transforming data:', error);
    return {
      locationMetrics: [{
        metric: 'VIEWS_MAPS',
        metricValues: [{ value: '0', time: new Date().toISOString() }]
      }]
    };
  }
}

// Get available metrics
router.get('/metrics', async (req, res) => {
  try {
    // Complete list of available metrics with their API mappings
    const availableMetrics = [
      // Core View Metrics (most commonly used)
      'VIEWS_MAPS',         // Total Maps views (desktop + mobile)
      'VIEWS_SEARCH',       // Total Search views (desktop + mobile)
      
      // Detailed View Metrics by Platform
      'VIEWS_MAPS_DESKTOP',     // Maps views on desktop only
      'VIEWS_MAPS_MOBILE',      // Maps views on mobile only  
      'VIEWS_SEARCH_DESKTOP',   // Search views on desktop only
      'VIEWS_SEARCH_MOBILE',    // Search views on mobile only
      
      // Action Metrics
      'ACTIONS_PHONE',          // Phone number clicks
      'ACTIONS_WEBSITE',        // Website button clicks
      'ACTIONS_DRIVING_DIRECTIONS', // Direction requests
      
      // Communication Metrics
      'BUSINESS_CONVERSATIONS', // Message conversations received
      
      // Booking & Order Metrics (for applicable businesses)
      'BUSINESS_BOOKINGS',      // Reserve with Google bookings
      'BUSINESS_FOOD_ORDERS',   // Food orders received
      'BUSINESS_FOOD_MENU_CLICKS' // Menu content interactions
    ];

    res.json({
      success: true,
      metrics: availableMetrics,
      apiMapping: {
        'VIEWS_MAPS': ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
        'VIEWS_SEARCH': ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
        'VIEWS_MAPS_DESKTOP': ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS'],
        'VIEWS_MAPS_MOBILE': ['BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
        'VIEWS_SEARCH_DESKTOP': ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'],
        'VIEWS_SEARCH_MOBILE': ['BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
        'ACTIONS_PHONE': ['CALL_CLICKS'],
        'ACTIONS_WEBSITE': ['WEBSITE_CLICKS'],
        'ACTIONS_DRIVING_DIRECTIONS': ['BUSINESS_DIRECTION_REQUESTS'],
        'BUSINESS_CONVERSATIONS': ['BUSINESS_CONVERSATIONS'],
        'BUSINESS_BOOKINGS': ['BUSINESS_BOOKINGS'],
        'BUSINESS_FOOD_ORDERS': ['BUSINESS_FOOD_ORDERS'],
        'BUSINESS_FOOD_MENU_CLICKS': ['BUSINESS_FOOD_MENU_CLICKS']
      },
      options: {
        timeRange: ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'],
        note: 'All metrics use fetchMultiDailyMetricsTimeSeries with correct DailyMetric enum values'
      }
    });
  } catch (error) {
    console.error('Error fetching available metrics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available metrics'
    });
  }
});

module.exports = router;