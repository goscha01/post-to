-- Phase 1E extension: let a Campaign Assistant conversation carry a Meta
-- ad-account reference alongside its Google Ads customer + campaign.
--
-- Nullable so existing conversations (which don't have Meta scoped) stay
-- valid unchanged. When set, POST /conversations/:id/refresh-snapshot uses
-- it to re-fetch Meta on refresh, and the initial POST /conversations
-- captures the account into the report_snapshot on creation.
--
-- Safe to re-run: IF NOT EXISTS.

ALTER TABLE campaign_assistant_conversations
  ADD COLUMN IF NOT EXISTS meta_ads_account_id VARCHAR(64);
