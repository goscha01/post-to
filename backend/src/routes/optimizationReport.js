// Consolidated Google Ads + GA4 report endpoint.
//
// GET /api/optimization-report?customerId=&days=&campaignId=&propertyId=
//     &searchTermSpendThreshold=&landingPageSessionThreshold=
//     &lowQualityScoreCutoff=
//
// Returns a single JSON blob with:
//   - meta (customer, dates, filters)
//   - summary (rolled-up KPIs)
//   - alerts (rows matching well-known optimization patterns)
//   - diagnostics + all Ads report sections
//   - ga4 (overview/landing/traffic/events/campaigns/geography/devices)
//   - crossReference.byCampaign — Ads↔GA4 join by (campaign, google, cpc)
//   - errors[] for any section that failed
//
// This is the endpoint intended for ChatGPT ingestion. The report is
// pure data — no AI-generated advice.

const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const optimizationReport = require('../services/optimizationReportService');
const { getAllBusinessTokens } = require('../utils/businessTokens');
const logger = require('../utils/logger');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);
router.use(requireBusinessAuth);

const ALLOWED_DAYS = [1, 7, 14, 30, 60, 90, 180, 365];

function parseDays(req) {
  const raw = parseInt(req.query.days, 10);
  if (!ALLOWED_DAYS.includes(raw)) return 30;
  return raw;
}

function parseCampaignId(req) {
  const raw = String(req.query.campaignId || '').replace(/[^0-9]/g, '');
  return raw || null;
}

function parseThresholds(req) {
  const num = (k, dflt) => {
    const n = Number(req.query[k]);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    searchTermSpendThreshold: num('searchTermSpendThreshold', 20),
    keywordSpendThreshold: num('keywordSpendThreshold', 20),
    landingPageSessionThreshold: num('landingPageSessionThreshold', 50),
    lowQualityScoreCutoff: num('lowQualityScoreCutoff', 4),
  };
}

// Pull the Ads customer + owner metadata. The manager CID (login-customer-id)
// is required for sub-customers under an MCC.
async function resolveAdsCustomer(req) {
  const explicit = String(req.query.customerId || '').replace(/[^0-9]/g, '');
  const cid = explicit || null;
  if (!cid) {
    const { data } = await supabase
      .from('connected_accounts')
      .select('metadata, created_at')
      .eq('user_id', req.user.userId)
      .eq('provider', 'google_ads')
      .order('created_at', { ascending: false })
      .limit(1);
    if (data && data[0]) {
      return {
        customerId: data[0].metadata?.customer_id,
        loginCustomerId: data[0].metadata?.manager_customer_id || null,
        ownerGoogleId: data[0].metadata?.owner_google_id || null,
        descriptiveName: data[0].display_name || null,
        currencyCode: data[0].metadata?.currency_code || null,
        timeZone: data[0].metadata?.time_zone || null,
      };
    }
    return { customerId: null };
  }
  const { data: rows } = await supabase
    .from('connected_accounts')
    .select('display_name, metadata')
    .eq('user_id', req.user.userId)
    .eq('provider', 'google_ads')
    .eq('external_id', `ads:${cid}`)
    .limit(1);
  const meta = rows && rows[0]?.metadata;
  return {
    customerId: cid,
    loginCustomerId: meta?.manager_customer_id || null,
    ownerGoogleId: meta?.owner_google_id || null,
    descriptiveName: rows && rows[0]?.display_name || null,
    currencyCode: meta?.currency_code || null,
    timeZone: meta?.time_zone || null,
  };
}

async function resolveGa4Property(req) {
  const explicit = String(req.query.propertyId || '').trim();
  if (explicit) {
    const { data } = await supabase
      .from('connected_accounts')
      .select('metadata, display_name')
      .eq('user_id', req.user.userId)
      .eq('provider', 'google_analytics')
      .eq('external_id', `ga4:${explicit}`)
      .limit(1);
    return {
      propertyId: explicit,
      ownerGoogleId: data && data[0]?.metadata?.owner_google_id || null,
      displayName: data && data[0]?.display_name || null,
    };
  }
  const { data } = await supabase
    .from('connected_accounts')
    .select('metadata, display_name, created_at')
    .eq('user_id', req.user.userId)
    .eq('provider', 'google_analytics')
    .order('created_at', { ascending: false })
    .limit(1);
  if (!data || !data[0]) return { propertyId: null };
  return {
    propertyId: data[0].metadata?.property_id || null,
    ownerGoogleId: data[0].metadata?.owner_google_id || null,
    displayName: data[0].display_name || null,
  };
}

async function tokenForOwner(req, ownerGoogleId) {
  if (!ownerGoogleId) return req.businessToken;
  const tokens = await getAllBusinessTokens(req.user.userId);
  const match = tokens.find(t => t.google_id === ownerGoogleId);
  return match?.access_token || req.businessToken;
}

router.get('/', async (req, res) => {
  const t0 = Date.now();
  try {
    const days = parseDays(req);
    const campaignId = parseCampaignId(req);
    const thresholds = parseThresholds(req);

    const [adsCustomer, ga4Property] = await Promise.all([
      resolveAdsCustomer(req),
      resolveGa4Property(req),
    ]);

    if (!adsCustomer.customerId) {
      return res.status(400).json({
        error: 'No Google Ads customer specified or connected',
        needsCustomerSelection: true,
      });
    }

    const [adsAccessToken, ga4AccessToken] = await Promise.all([
      tokenForOwner(req, adsCustomer.ownerGoogleId),
      ga4Property.propertyId ? tokenForOwner(req, ga4Property.ownerGoogleId) : Promise.resolve(null),
    ]);

    const report = await optimizationReport.generateReport({
      adsAccessToken,
      customerId: adsCustomer.customerId,
      loginCustomerId: adsCustomer.loginCustomerId,
      campaignId,
      ga4AccessToken,
      propertyId: ga4Property.propertyId,
      days,
      thresholds,
      userId: req.user.userId,
    });

    // Stamp the account block onto the report so ChatGPT sees which account
    // it's looking at without needing to cross-reference the URL.
    report.account = {
      customerId: adsCustomer.customerId,
      descriptiveName: adsCustomer.descriptiveName,
      currencyCode: adsCustomer.currencyCode,
      timeZone: adsCustomer.timeZone,
      loginCustomerId: adsCustomer.loginCustomerId,
      ga4PropertyId: ga4Property.propertyId,
      ga4PropertyName: ga4Property.displayName,
    };

    logger.info('optimizationReport.ok', {
      userId: req.user.userId,
      customerId: adsCustomer.customerId,
      propertyId: ga4Property.propertyId || null,
      days,
      campaignId: campaignId || null,
      sectionErrors: (report.errors || []).length,
      duration_ms: Date.now() - t0,
    });

    res.json(report);
  } catch (err) {
    logger.error('optimizationReport.failed', {
      userId: req.user.userId,
      error: err.message,
      status: err?.response?.status || null,
      duration_ms: Date.now() - t0,
    });
    res.status(err.status || 500).json({ error: err.message || 'Failed to generate optimization report' });
  }
});

module.exports = router;
