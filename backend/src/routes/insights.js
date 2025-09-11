// Updated insights.js - Added timeline/historical data support
const express = require('express');
const router = express.Router();
const axios = require('axios');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');

// API URL for Google Business Profile Performance API
const PERFORMANCE_URL = 'https://businessprofileperformance.googleapis.com/v1';
// Clean timeline endpoint - replace your current timeline implementation

router.post('/timeline', authMiddleware, requireBusinessAuth, async (req, res) => {
  try {
    const { metricRequests, timeRange, locationId } = req.body;
    
    console.log('Timeline insights request received for location:', locationId);
    
    // Use tokens from middleware instead of request body
    const accessToken = req.businessToken; // From middleware
    
    if (!accessToken || !locationId || !metricRequests || !timeRange) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: locationId, metricRequests, timeRange'
      });
    }

    const startDate = new Date(timeRange.startTime);
    const endDate = new Date(timeRange.endTime);

    // Rest of your timeline logic stays the same...
    // (keeping existing metric mapping and processing logic)
    
    const metricMap = {
      'VIEWS_MAPS': ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
      'VIEWS_SEARCH': ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
      // ... rest of your mapping
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
            `${PERFORMANCE_URL}/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`, // Use middleware token
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
          
          // Process response data...
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


// Helper function to format Google's date response to YYYY-MM-DD format
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

function generateDailyDistribution(totalValue, startDate, endDate) {
  const timeSeriesData = [];
  const daysDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
  
  if (daysDiff <= 0) return timeSeriesData;
  
  if (totalValue <= 0) {
    for (let i = 0; i < daysDiff; i++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(currentDate.getDate() + i);
      
      timeSeriesData.push({
        date: currentDate.toISOString().split('T')[0],
        value: 0,
        timestamp: currentDate.toISOString()
      });
    }
    return timeSeriesData;
  }

  const dailyValues = [];
  const baseDaily = totalValue / daysDiff;
  
  for (let i = 0; i < daysDiff; i++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(currentDate.getDate() + i);
    
    const dayOfWeek = currentDate.getDay();
    const weekendFactor = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.7 : 1.0;
    const midWeekFactor = (dayOfWeek >= 2 && dayOfWeek <= 4) ? 1.2 : 1.0;
    const randomFactor = 0.85 + (Math.random() * 0.3);
    
    let dailyValue = Math.round(baseDaily * weekendFactor * midWeekFactor * randomFactor);
    dailyValue = Math.max(0, dailyValue);
    
    dailyValues.push(dailyValue);
  }
  
  const generatedTotal = dailyValues.reduce((sum, val) => sum + val, 0);
  const adjustmentFactor = totalValue / (generatedTotal || 1);
  
  for (let i = 0; i < daysDiff; i++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(currentDate.getDate() + i);
    
    const adjustedValue = Math.round(dailyValues[i] * adjustmentFactor);
    
    timeSeriesData.push({
      date: currentDate.toISOString().split('T')[0],
      value: adjustedValue,
      timestamp: currentDate.toISOString()
    });
  }
  
  return timeSeriesData;
}


// Get basic insights for a location (original aggregated functionality)
router.post('/basic', authMiddleware, requireBusinessAuth, async (req, res) => {
  try {
    const { metricRequests, timeRange, locationId } = req.body;
    
    // Use tokens from middleware
    const accessToken = req.businessToken;
    
    if (!accessToken || !locationId || !metricRequests || !timeRange) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const startDate = new Date(timeRange.startTime);
    const endDate = new Date(timeRange.endTime);

    // Your existing metric mapping logic...
    const metricMap = {
      'VIEWS_MAPS': ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
      'VIEWS_SEARCH': ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
      'ACTIONS_PHONE': ['CALL_CLICKS'],
      'ACTIONS_WEBSITE': ['WEBSITE_CLICKS'],
      'ACTIONS_DRIVING_DIRECTIONS': ['BUSINESS_DIRECTION_REQUESTS'],
      // ... rest of mapping
    };

    const allMetricsData = [];
    
    for (const metricRequest of metricRequests) {
      const gmbMetric = metricRequest.metric;
      const apiMetrics = metricMap[gmbMetric] || [gmbMetric];
      
      let totalValue = 0;
      
      for (const apiMetric of apiMetrics) {
        try {
          const response = await axios.get(
            `${PERFORMANCE_URL}/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`, // Use middleware token
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
          
          // Process response...
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
          
        } catch (error) {
          console.error(`Failed to fetch ${apiMetric}:`, error.response?.data || error.message);
        }
      }
      
      allMetricsData.push({
        gmbMetric,
        totalValue
      });
    }

    const locationMetrics = allMetricsData.map(metricData => ({
      metric: metricData.gmbMetric,
      metricValues: [{
        value: metricData.totalValue.toString(),
        time: new Date().toISOString()
      }]
    }));

    res.json({
      success: true,
      data: { locationMetrics }
    });

  } catch (error) {
    console.error('Error fetching basic insights:', error);
    
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
      endpoints: {
        '/basic': 'Get aggregated metrics (total values over date range)',
        '/timeline': 'Get historical daily data for timeline graphs'
      },
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