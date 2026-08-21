-- Campaign Assistant — living plan model.
--
-- Old model: each regenerate created a brand-new plan row + brand-new step
-- rows. Continuity between plans was reconstructed via fuzzy title matching
-- (Jaccard on tokens), which broke every time the AI phrased a step slightly
-- differently. Result: "my done tasks keep coming back as pending" bug that
-- persisted across ~10 rounds of patches.
--
-- New model: one plan per conversation is marked as the "living" plan.
-- Regeneration MUTATES that plan's steps in place — AI outputs edit ops
-- (add / refactor / mark / drop) that reference step_id, so step identity
-- (and status) is stable across regenerations by construction. No more
-- fuzzy-matching required.
--
-- Historical plans stay in the DB as-is (for audit / rollback if we ever
-- need it) but only living plans are surfaced in the UI.
--
-- Safe to re-run: IF NOT EXISTS / DO NOTHING everywhere.

-- ============================================================================
-- Add is_living flag
-- ============================================================================
ALTER TABLE campaign_assistant_action_plans
  ADD COLUMN IF NOT EXISTS is_living BOOLEAN DEFAULT false;

-- ============================================================================
-- Backfill: mark the most recent plan per conversation as living so existing
-- conversations transition cleanly. All prior plans become archived history.
-- ============================================================================
UPDATE campaign_assistant_action_plans p
SET is_living = true
FROM (
  SELECT DISTINCT ON (conversation_id) id
  FROM campaign_assistant_action_plans
  ORDER BY conversation_id, created_at DESC
) latest
WHERE p.id = latest.id
  AND p.is_living IS DISTINCT FROM true;

-- ============================================================================
-- Enforce at-most-one living plan per conversation.
-- Partial index so archived plans (is_living=false) don't conflict.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_ca_action_plans_one_living_per_conv
  ON campaign_assistant_action_plans(conversation_id)
  WHERE is_living = true;

CREATE INDEX IF NOT EXISTS idx_ca_action_plans_conversation_living
  ON campaign_assistant_action_plans(conversation_id, is_living);
