const express = require('express');
const router = express.Router();
const axios = require('axios');

// API URL for Google Business Profile Performance API
const PERFORMANCE_URL = 'https://businessprofileperformance.googleapis.com/v1';

// Get basic insights for a location using Performance API
router.post('/basic', async (req, res) => {
  try {
    // Extract from request body (not headers)
    const { accessToken, accountId, locationId, metricRequests, timeRange } = req.body;
    
    // Log request details
    console.log('📥 Insights request received for location:', locationId);
    
    if (!accessToken) {
      console.log('❌ No access token found in request body');
      return res.status(400).json({ 
        success: false,
        error: 'Access token required in request body' 
      });
    }



    if (!accountId || !locationId || !metricRequests || !timeRange) {
      console.log('❌ Missing required parameters');
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: accountId, locationId, metricRequests, timeRange'
      });
    }

    // Parse dates for the Performance API
    const startDate = new Date(timeRange.startTime);
    const endDate = new Date(timeRange.endTime);

    // Convert metrics to Performance API format (using correct metric names)
    // Google Performance API only accepts one metric at a time, so we need to make multiple calls
    const metricMap = {
         'QUERIES_DIRECT': 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
         'QUERIES_INDIRECT': 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
         'VIEWS_MAPS': 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
         'VIEWS_SEARCH': 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
         'ACTIONS_PHONE': 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', // Use mobile search for phone actions
         'ACTIONS_WEBSITE': 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', // Use mobile maps for website clicks
         'ACTIONS_DRIVING_DIRECTIONS': 'BUSINESS_IMPRESSIONS_MOBILE_MAPS' // Use mobile maps for driving
       };

    console.log('📤 Fetching insights for', metricRequests.length, 'metrics');

    // Make separate API calls for each metric and combine results
    const allMetricsData = [];
    
    for (const metricRequest of metricRequests) {
      const gmbMetric = metricRequest.metric;
      const performanceMetric = metricMap[gmbMetric] || 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS';
      
      try {
         const response = await axios.get(
           `${PERFORMANCE_URL}/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
           {
             headers: {
               'Authorization': `Bearer ${accessToken}`,
               'Content-Type': 'application/json'
             },
             params: {
               dailyMetrics: performanceMetric,
               'dailyRange.startDate.year': startDate.getFullYear(),
               'dailyRange.startDate.month': startDate.getMonth() + 1,
               'dailyRange.endDate.year': endDate.getFullYear(),
               'dailyRange.endDate.month': endDate.getMonth() + 1,
               'dailyRange.startDate.day': startDate.getDate(),
               'dailyRange.endDate.day': endDate.getDate()
             }
           }
         );
         
          // Store the response with the original GMB metric name for mapping
          allMetricsData.push({
            gmbMetric: gmbMetric,
            performanceMetric: performanceMetric,
            data: response.data
          });
          
        } catch (error) {
          console.error(`❌ Failed to fetch ${gmbMetric}:`, error.response?.data || error.message);
          // Continue with other metrics even if one fails
        }
      }

      console.log('✅ All metrics fetched successfully');

      // Transform all metrics data to match expected format
      const transformedData = transformMultipleMetricsData(allMetricsData, metricRequests);

      res.json({
        success: true,
        data: transformedData
      });

  } catch (error) {
    console.error('🚨 Error fetching basic insights:', error);
    
    if (error.response && error.response.data) {
      console.error('📥 Performance API Error Response:', JSON.stringify(error.response.data, null, 2));
      console.error('📥 Performance API Error Status:', error.response.status);
      res.status(error.response.status).json({
        success: false,
        error: 'Performance API Error',
        details: error.response.data
      });
    } else {
      console.error('📥 Non-API Error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch insights',
        message: error.message
      });
    }
  }
});

// Get driving directions insights using Performance API
router.post('/driving-directions', async (req, res) => {
  try {
    // Log request details
    console.log('📥 Driving directions request received');
    
    // Extract from request body (not headers)
    const { accessToken, accountId, locationId, numDays = 'NINETY' } = req.body;
    
    if (!accessToken) {
      console.log('❌ No access token found in request body for driving directions');
      return res.status(400).json({ 
        success: false,
        error: 'Access token required in request body' 
      });
    }



    if (!accountId || !locationId) {
      console.log('❌ Missing required parameters for driving directions');
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: accountId, locationId'
      });
    }

    // Calculate date range based on numDays
    const endDate = new Date();
    const startDate = new Date();
    const daysMap = { 'SEVEN': 7, 'THIRTY': 30, 'NINETY': 90 };
    startDate.setDate(endDate.getDate() - (daysMap[numDays] || 90));

    // Use Performance API for driving directions data
    const response = await axios.get(
      `${PERFORMANCE_URL}/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        params: {
          dailyMetrics: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
          'dailyRange.startDate.year': startDate.getFullYear(),
          'dailyRange.startDate.month': startDate.getMonth() + 1,
          'dailyRange.startDate.day': startDate.getDate(),
          'dailyRange.endDate.year': endDate.getFullYear(),
          'dailyRange.endDate.month': endDate.getMonth() + 1,
          'dailyRange.endDate.day': endDate.getDate()
        }
      }
    );

    console.log('✅ Driving directions response received');

    // Transform the response to match expected format
    const transformedData = transformPerformanceData(response.data, [
      { metric: 'ACTIONS_DRIVING_DIRECTIONS' }
    ]);

    res.json({
      success: true,
      data: transformedData
    });

  } catch (error) {
    console.error('🚨 Error fetching driving directions insights:', error);
    
    if (error.response && error.response.data) {
      console.error('📥 Performance API Error Response:', JSON.stringify(error.response.data, null, 2));
      res.status(error.response.status).json({
        success: false,
        error: 'Performance API Error',
        details: error.response.data
      });
    } else {
      console.error('📥 Non-API Error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch driving directions insights',
        message: error.message
      });
    }
  }
});

// Get available metrics
router.get('/metrics', async (req, res) => {
  try {
         // Updated metrics that work with Performance API (using correct names)
     const availableMetrics = [
       'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
       'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
       'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
       'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
     ];

    const metricOptions = {
      timeRange: ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'],
      numDays: ['SEVEN', 'THIRTY', 'NINETY']
    };

    console.log('📤 Sending available Performance API metrics to frontend');

    res.json({
      success: true,
      metrics: availableMetrics,
      options: metricOptions
    });
  } catch (error) {
    console.error('🚨 Error fetching available metrics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available metrics',
      message: error.message
    });
  }
});

// Export insights data using Performance API
router.post('/export', async (req, res) => {
  try {
    // Log request details
    console.log('📥 Export request received');
    
    // Extract from request body (not headers)
    const { accessToken, accountId, locationId, format = 'json', startDate, endDate } = req.body;
    
    if (!accessToken) {
      console.log('❌ No access token found in request body for export');
      return res.status(400).json({ 
        success: false,
        error: 'Access token required in request body' 
      });
    }



    if (!accountId || !locationId) {
      console.log('❌ Missing required parameters for export');
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: accountId, locationId'
      });
    }

    // Parse dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    // Get the primary metric from Performance API (using single metric for now)
    const primaryMetric = 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS';

    const response = await axios.get(
      `${PERFORMANCE_URL}/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        params: {
          dailyMetrics: primaryMetric,
          'dailyRange.startDate.year': start.getFullYear(),
          'dailyRange.startDate.month': start.getMonth() + 1,
          'dailyRange.startDate.day': start.getDate(),
          'dailyRange.endDate.year': end.getFullYear(),
          'dailyRange.endDate.month': end.getMonth() + 1,
          'dailyRange.endDate.day': end.getDate()
        }
      }
    );

    if (format === 'csv') {
      // Transform and convert to CSV format
      const transformedData = transformPerformanceData(response.data, [{ metric: primaryMetric }]);
      const csvData = convertToCSV(transformedData);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="gmb_insights_${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csvData);
      console.log('✅ CSV export completed');
    } else {
      // Transform and return JSON
      const transformedData = transformPerformanceData(response.data, [{ metric: primaryMetric }]);
      res.json({
        success: true,
        data: transformedData
      });
      console.log('✅ JSON export completed');
    }
  } catch (error) {
    console.error('🚨 Error exporting insights:', error);
    
    if (error.response && error.response.data) {
      console.error('📥 Performance API Error Response:', JSON.stringify(error.response.data, null, 2));
      res.status(error.response.status).json({
        success: false,
        error: 'Performance API Error',
        details: error.response.data
      });
    } else {
      console.error('📥 Non-API Error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to export insights',
        message: error.message
      });
    }
  }
});

// Helper function to transform multiple metrics data to expected format
function transformMultipleMetricsData(allMetricsData, originalMetrics) {
  try {
    const locationMetrics = [];
    
    // Process each metric's data
    for (const metricData of allMetricsData) {
      const { gmbMetric, performanceMetric, data } = metricData;
      
      // Transform this metric's data
      const transformedMetric = transformPerformanceData(data, [{ metric: gmbMetric }]);
      
      if (transformedMetric.locationMetrics && transformedMetric.locationMetrics.length > 0) {
        // Update the metric name to match the original GMB metric
        const metric = transformedMetric.locationMetrics[0];
        metric.metric = gmbMetric;
        locationMetrics.push(metric);
      }
    }
    
    return {
      locationMetrics: locationMetrics
    };
  } catch (error) {
    console.error('🚨 Error transforming multiple metrics data:', error);
    return {
      locationMetrics: [{
        metric: 'VIEWS_MAPS',
        metricValues: [{
          value: '0',
          time: new Date().toISOString()
        }]
      }]
    };
  }
}

// Helper function to transform Performance API data to expected format
function transformPerformanceData(performanceData, originalMetrics) {
  try {
    // Create a mapping from Performance API metrics back to original GMB metrics
    const metricMapping = {
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS': 'VIEWS_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH': 'VIEWS_SEARCH',
      'BUSINESS_ACTIONS_PHONE': 'ACTIONS_PHONE',
      'BUSINESS_ACTIONS_WEBSITE': 'ACTIONS_WEBSITE',
      'BUSINESS_ACTIONS_DRIVING_DIRECTIONS': 'ACTIONS_DRIVING_DIRECTIONS'
    };

    const locationMetrics = [];
    
    // Handle different possible response structures
    if (performanceData.multiDailyMetricTimeSeries) {
      performanceData.multiDailyMetricTimeSeries.forEach(metricSeries => {
        // Extract metric name from the nested structure
        let metricName = null;
        let totalValue = 0;
        
        if (metricSeries.dailyMetricTimeSeries && metricSeries.dailyMetricTimeSeries.length > 0) {
          const firstMetricSeries = metricSeries.dailyMetricTimeSeries[0];
          metricName = firstMetricSeries.dailyMetric;
          
          // Calculate total value from datedValues
          if (firstMetricSeries.timeSeries && firstMetricSeries.timeSeries.datedValues) {
            firstMetricSeries.timeSeries.datedValues.forEach(datedValue => {
              if (datedValue.value) {
                totalValue += parseInt(datedValue.value) || 0;
              }
            });
          }
        }
        
         if (metricName) {
           const originalMetricName = metricMapping[metricName] || metricName;
           
           locationMetrics.push({
             metric: originalMetricName,
             metricValues: [{
               value: totalValue.toString(),
               time: new Date().toISOString()
             }]
           });
         }
      });
    } else if (performanceData.dailyMetricTimeSeries) {
      // Handle single metric response
      const metricName = performanceData.dailyMetricTimeSeries.dailyMetric;
      const originalMetricName = metricMapping[metricName] || metricName;
      
      let totalValue = 0;
      if (performanceData.dailyMetricTimeSeries.dailyTimeSeries && performanceData.dailyMetricTimeSeries.dailyTimeSeries.timeSeries) {
        performanceData.dailyMetricTimeSeries.dailyTimeSeries.timeSeries.forEach(timePoint => {
          if (timePoint.value && timePoint.value.dailyMetricValues) {
            timePoint.value.dailyMetricValues.forEach(dailyValue => {
              if (dailyValue.value && dailyValue.value.value) {
                totalValue += parseInt(dailyValue.value.value) || 0;
              }
            });
          }
        });
      }

      locationMetrics.push({
        metric: originalMetricName,
        metricValues: [{
          value: totalValue.toString(),
          time: new Date().toISOString()
        }]
      });
    } else {
      // Fallback: create a default metric structure
      locationMetrics.push({
        metric: 'VIEWS_MAPS',
        metricValues: [{
          value: '0',
          time: new Date().toISOString()
        }]
      });
    }

    return {
      locationMetrics: locationMetrics
    };
  } catch (error) {
    console.error('🚨 Error transforming performance data:', error);
    return {
      locationMetrics: [{
        metric: 'VIEWS_MAPS',
        metricValues: [{
          value: '0',
          time: new Date().toISOString()
        }]
      }]
    };
  }
}

// Helper function to convert insights data to CSV
function convertToCSV(data) {
  if (!data.locationMetrics) return '';
  
  const headers = ['Metric', 'Value', 'Time'];
  const rows = data.locationMetrics.map(metric => [
    metric.metric,
    metric.metricValues?.[0]?.value || 0,
    metric.metricValues?.[0]?.time || ''
  ]);
  
  return [headers, ...rows]
    .map(row => row.map(cell => `"${cell}"`).join(','))
    .join('\n');
}

module.exports = router;
