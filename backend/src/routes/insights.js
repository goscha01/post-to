// Insights routes hit Google's Business Profile Performance API. Users often
// have >1 Google account connected (business_profiles JSONB) and the selected
// location may live under any of them, so we iterate every token via
// tryWithEachBusinessToken — first token whose call returns non-empty wins.
//
// All decision points log to Loki under `insights.*` so failures are visible
// (previously the file silently returned zeros on every error).

const express = require('express');
const router = express.Router();
const axios = require('axios');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const { tryWithEachBusinessToken } = require('../utils/businessTokens');
const logger = require('../utils/logger');

const PERFORMANCE_URL = 'https://businessprofileperformance.googleapis.com/v1';

// Dashboard metric → underlying Google DailyMetric enum(s). Shared by /basic
// and /timeline. Some dashboard metrics aggregate desktop + mobile so they
// require two API calls.
const METRIC_MAP = {
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
  'BUSINESS_FOOD_MENU_CLICKS': ['BUSINESS_FOOD_MENU_CLICKS'],
};

function statusOf(err) {
  return err?.response?.status ?? err?.code ?? null;
}

// Fetch a single API metric's timeseries for one location with one access
// token. Throws on any HTTP error so tryWithEachBusinessToken can react.
async function fetchDailyMetric(locationId, apiMetric, accessToken, startDate, endDate) {
  const response = await axios.get(
    `${PERFORMANCE_URL}/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      params: {
        dailyMetrics: apiMetric,
        'dailyRange.startDate.year': startDate.getFullYear(),
        'dailyRange.startDate.month': startDate.getMonth() + 1,
        'dailyRange.startDate.day': startDate.getDate(),
        'dailyRange.endDate.year': endDate.getFullYear(),
        'dailyRange.endDate.month': endDate.getMonth() + 1,
        'dailyRange.endDate.day': endDate.getDate(),
      },
    }
  );
  return response.data;
}

function formatGoogleDate(googleDate) {
  if (typeof googleDate === 'string') return googleDate;
  if (googleDate?.year && googleDate?.month && googleDate?.day) {
    const month = googleDate.month.toString().padStart(2, '0');
    const day = googleDate.day.toString().padStart(2, '0');
    return `${googleDate.year}-${month}-${day}`;
  }
  return new Date().toISOString().split('T')[0];
}

// /basic — aggregated totals per dashboard metric over the date range.
router.post('/basic', authMiddleware, requireBusinessAuth, async (req, res) => {
  const { accountId, locationId, metricRequests, timeRange } = req.body;
  const userId = req.user?.userId;

  if (!locationId || !metricRequests || !timeRange) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameters: locationId, metricRequests, timeRange',
    });
  }

  const startDate = new Date(timeRange.startTime);
  const endDate = new Date(timeRange.endTime);

  logger.info('insights.basic.request', {
    user_id: userId,
    account_id: accountId,
    location_id: locationId,
    metric_count: metricRequests.length,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
  });

  try {
    let tokenIdx = -1;
    const attempt = await tryWithEachBusinessToken(userId, req.businessToken, async (accessToken, profile) => {
      tokenIdx += 1;
      const allMetricsData = [];
      let firstOk = false;

      for (const metricRequest of metricRequests) {
        const gmbMetric = metricRequest.metric;
        const apiMetrics = METRIC_MAP[gmbMetric] || [gmbMetric];
        let totalValue = 0;

        for (const apiMetric of apiMetrics) {
          try {
            const data = await fetchDailyMetric(locationId, apiMetric, accessToken, startDate, endDate);
            firstOk = true;
            if (data.multiDailyMetricTimeSeries) {
              data.multiDailyMetricTimeSeries.forEach(metricSeries => {
                (metricSeries.dailyMetricTimeSeries || []).forEach(dailySeries => {
                  (dailySeries.timeSeries?.datedValues || []).forEach(dv => {
                    if (dv.value) totalValue += parseInt(dv.value) || 0;
                  });
                });
              });
            }
          } catch (err) {
            const s = statusOf(err);
            // Before we've had a single success with this token, any 401/403/404
            // means "wrong token for this location" — throw so we advance to
            // the next business_profile token.
            if (!firstOk && (s === 401 || s === 403 || s === 404)) {
              logger.warn('insights.basic.token_attempt_error', {
                user_id: userId,
                location_id: locationId,
                token_index: tokenIdx,
                token_email: profile?.email || null,
                api_metric: apiMetric,
                status: s,
                error: err?.message,
              });
              throw err;
            }
            // Already validated this token — a per-metric failure just means
            // that particular metric isn't available for this location
            // (common for BUSINESS_BOOKINGS / food metrics on non-restaurant
            // businesses). Skip it.
            logger.warn('insights.basic.metric_skipped', {
              user_id: userId,
              location_id: locationId,
              api_metric: apiMetric,
              status: s,
              error: err?.message,
            });
          }
        }

        allMetricsData.push({ gmbMetric, totalValue });
      }

      logger.info('insights.basic.token_attempt_ok', {
        user_id: userId,
        location_id: locationId,
        token_index: tokenIdx,
        token_email: profile?.email || null,
        totals: Object.fromEntries(allMetricsData.map(m => [m.gmbMetric, m.totalValue])),
      });

      return { allMetricsData };
    });

    if (!attempt.ok) {
      if (attempt.allUnauthorized) {
        logger.warn('insights.basic.all_tokens_failed', {
          user_id: userId,
          location_id: locationId,
          tokens_tried: attempt.tried,
        });
        return res.json({
          success: true,
          data: { locationMetrics: [] },
          message: 'No connected Google profile has access to this location',
        });
      }
      logger.error('insights.basic.api_error', {
        user_id: userId,
        location_id: locationId,
        error: attempt.error?.message,
        status: statusOf(attempt.error),
      });
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch insights',
        message: attempt.error?.message,
      });
    }

    const locationMetrics = attempt.result.allMetricsData.map(m => ({
      metric: m.gmbMetric,
      metricValues: [{ value: m.totalValue.toString(), time: new Date().toISOString() }],
    }));

    res.json({ success: true, data: { locationMetrics } });
  } catch (error) {
    logger.error('insights.basic.unhandled', {
      user_id: userId,
      location_id: locationId,
      error: error?.message,
      stack: (error?.stack || '').slice(0, 1500),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch insights',
      message: error.message,
    });
  }
});

// /timeline — per-day breakdown for chart rendering.
router.post('/timeline', authMiddleware, requireBusinessAuth, async (req, res) => {
  const { accountId, locationId, metricRequests, timeRange } = req.body;
  const userId = req.user?.userId;

  if (!locationId || !metricRequests || !timeRange) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameters: locationId, metricRequests, timeRange',
    });
  }

  const startDate = new Date(timeRange.startTime);
  const endDate = new Date(timeRange.endTime);

  logger.info('insights.timeline.request', {
    user_id: userId,
    account_id: accountId,
    location_id: locationId,
    metric_count: metricRequests.length,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
  });

  try {
    let tokenIdx = -1;
    const attempt = await tryWithEachBusinessToken(userId, req.businessToken, async (accessToken, profile) => {
      tokenIdx += 1;
      const timelineMetrics = [];
      let firstOk = false;

      for (const metricRequest of metricRequests) {
        const gmbMetric = metricRequest.metric;
        const apiMetrics = METRIC_MAP[gmbMetric] || [gmbMetric];

        const dailyTotals = {};
        let totalValue = 0;

        for (const apiMetric of apiMetrics) {
          try {
            const data = await fetchDailyMetric(locationId, apiMetric, accessToken, startDate, endDate);
            firstOk = true;
            if (data.multiDailyMetricTimeSeries) {
              data.multiDailyMetricTimeSeries.forEach(metricSeries => {
                (metricSeries.dailyMetricTimeSeries || []).forEach(dailySeries => {
                  (dailySeries.timeSeries?.datedValues || []).forEach(dv => {
                    if (dv.value && dv.date) {
                      const dateStr = formatGoogleDate(dv.date);
                      const value = parseInt(dv.value) || 0;
                      dailyTotals[dateStr] = (dailyTotals[dateStr] || 0) + value;
                      totalValue += value;
                    }
                  });
                });
              });
            }
          } catch (err) {
            const s = statusOf(err);
            if (!firstOk && (s === 401 || s === 403 || s === 404)) {
              logger.warn('insights.timeline.token_attempt_error', {
                user_id: userId,
                location_id: locationId,
                token_index: tokenIdx,
                token_email: profile?.email || null,
                api_metric: apiMetric,
                status: s,
                error: err?.message,
              });
              throw err;
            }
            logger.warn('insights.timeline.metric_skipped', {
              user_id: userId,
              location_id: locationId,
              api_metric: apiMetric,
              status: s,
              error: err?.message,
            });
          }
        }

        const timeSeriesData = [];
        const daysDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
        for (let i = 0; i < daysDiff; i++) {
          const currentDate = new Date(startDate);
          currentDate.setDate(currentDate.getDate() + i);
          const dateStr = currentDate.toISOString().split('T')[0];
          timeSeriesData.push({
            date: dateStr,
            value: dailyTotals[dateStr] || 0,
            timestamp: currentDate.toISOString(),
          });
        }

        timelineMetrics.push({ metric: gmbMetric, timeSeriesData, totalValue });
      }

      logger.info('insights.timeline.token_attempt_ok', {
        user_id: userId,
        location_id: locationId,
        token_index: tokenIdx,
        token_email: profile?.email || null,
        totals: Object.fromEntries(timelineMetrics.map(m => [m.metric, m.totalValue])),
      });

      return { timelineMetrics };
    });

    if (!attempt.ok) {
      if (attempt.allUnauthorized) {
        logger.warn('insights.timeline.all_tokens_failed', {
          user_id: userId,
          location_id: locationId,
          tokens_tried: attempt.tried,
        });
        return res.json({
          success: true,
          data: {
            locationId,
            dateRange: {
              startDate: startDate.toISOString().split('T')[0],
              endDate: endDate.toISOString().split('T')[0],
            },
            metrics: [],
          },
          message: 'No connected Google profile has access to this location',
        });
      }
      logger.error('insights.timeline.api_error', {
        user_id: userId,
        location_id: locationId,
        error: attempt.error?.message,
        status: statusOf(attempt.error),
      });
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch timeline insights from Google API',
        message: attempt.error?.message,
      });
    }

    res.json({
      success: true,
      data: {
        locationId,
        dateRange: {
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
        },
        metrics: attempt.result.timelineMetrics,
      },
    });
  } catch (error) {
    logger.error('insights.timeline.unhandled', {
      user_id: userId,
      location_id: locationId,
      error: error?.message,
      stack: (error?.stack || '').slice(0, 1500),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch timeline insights from Google API',
      message: error.message,
    });
  }
});

// Get available metrics
router.get('/metrics', async (req, res) => {
  try {
    res.json({
      success: true,
      metrics: Object.keys(METRIC_MAP),
      endpoints: {
        '/basic': 'Get aggregated metrics (total values over date range)',
        '/timeline': 'Get historical daily data for timeline graphs',
      },
      apiMapping: METRIC_MAP,
      options: {
        timeRange: ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'],
        note: 'All metrics use fetchMultiDailyMetricsTimeSeries with correct DailyMetric enum values',
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch available metrics' });
  }
});

module.exports = router;
