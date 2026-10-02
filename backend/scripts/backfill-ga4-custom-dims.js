// Backfill script: for every connected GA4 property in Post-to, register
// the custom event dimensions (plan_id, billing_period) that Post-to's
// dashboard needs for per-parameter breakdowns.
//
// Idempotent — GA4 returns 409 ALREADY_EXISTS for dimensions already
// registered, which ensurePostToCustomDimensions handles as noop:true.
// Safe to re-run as often as needed.
//
// Run:
//   node backend/scripts/backfill-ga4-custom-dims.js
//
// Or via Railway (uses prod env + Supabase):
//   railway run --service self-post -- node backend/scripts/backfill-ga4-custom-dims.js
//
// Why this exists: /api/analytics/properties auto-registers these dims
// going forward (added same change), but users who connected GA4 before
// that endpoint change won't trigger it. One pass of this script
// backfills them.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const analytics = require('../src/services/analyticsService');
const { getAllBusinessTokens } = require('../src/utils/businessTokens');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

async function main() {
  console.log('[backfill-ga4-custom-dims] scanning connected GA4 properties…');

  const { data: rows, error } = await supabase
    .from('connected_accounts')
    .select('id, user_id, metadata, display_name')
    .eq('provider', 'google_analytics');

  if (error) throw error;

  const total = rows?.length || 0;
  console.log(`[backfill-ga4-custom-dims] found ${total} GA4 connection(s)`);

  const summary = { total, succeeded: 0, skipped: 0, failed: 0, details: [] };

  for (const row of rows || []) {
    const propertyId = row.metadata?.property_id;
    const ownerGoogleId = row.metadata?.owner_google_id;
    const label = `${row.display_name || '(no name)'} · property=${propertyId} · user=${row.user_id}`;

    if (!propertyId) {
      console.log(`[skip] no propertyId · ${label}`);
      summary.skipped++;
      continue;
    }

    // Resolve the OAuth access token for the account that owns this GA4
    // property. Mirrors tokenForProperty in routes/analytics.js — prefer
    // the owner_google_id match, fall back to the first business token.
    const tokens = await getAllBusinessTokens(row.user_id);
    if (!tokens?.length) {
      console.log(`[skip] no business tokens · ${label}`);
      summary.skipped++;
      continue;
    }
    const match = ownerGoogleId
      ? tokens.find(t => t.google_id === ownerGoogleId)
      : tokens[0];
    const accessToken = match?.access_token || tokens[0]?.access_token;
    if (!accessToken) {
      console.log(`[skip] no access_token · ${label}`);
      summary.skipped++;
      continue;
    }

    try {
      const results = await analytics.ensurePostToCustomDimensions(accessToken, propertyId);
      const statuses = results.map(r => `${r.parameterName}=${r.status}`).join(', ');
      console.log(`[ok]   ${statuses} · ${label}`);
      summary.succeeded++;
      summary.details.push({ propertyId, userId: row.user_id, results });
    } catch (err) {
      console.log(`[fail] ${err.message} · ${label}`);
      summary.failed++;
      summary.details.push({ propertyId, userId: row.user_id, error: err.message });
    }
  }

  console.log('\n[backfill-ga4-custom-dims] done.');
  console.log(`  total:     ${summary.total}`);
  console.log(`  succeeded: ${summary.succeeded}`);
  console.log(`  skipped:   ${summary.skipped}`);
  console.log(`  failed:    ${summary.failed}`);
}

main().catch(err => {
  console.error('[backfill-ga4-custom-dims] fatal:', err);
  process.exit(1);
});
