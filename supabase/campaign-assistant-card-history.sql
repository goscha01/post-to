-- Campaign Assistant — per-card history for "Ask about this" + "Step-by-step".
--
-- The main chat already persists messages under turn_index=0..N. The per-card
-- inline flows (steps / ask) live outside that linear order — they're keyed
-- to a specific issue card, not to a global turn. To share the same table
-- (RLS, indexes, cost tracking) we:
--   1. Make turn_index nullable (card-scoped rows have turn_index = NULL).
--   2. Add card_key — a stable client-computed slug like "claude:missing-
--      conversion-tracking" so all history for one issue (across steps +
--      asks) groups together.
--
-- Safe to re-run: IF NOT EXISTS / DROP NOT NULL are idempotent.

ALTER TABLE campaign_assistant_messages ALTER COLUMN turn_index DROP NOT NULL;

ALTER TABLE campaign_assistant_messages
  ADD COLUMN IF NOT EXISTS card_key VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_ca_messages_card_key
  ON campaign_assistant_messages(conversation_id, card_key, created_at)
  WHERE card_key IS NOT NULL;
