-- Campaign Assistant — auto-monitor for observation steps.
--
-- Observation-type steps ("wait 14 days, then check if metric X hit target Y")
-- shouldn't require the user to manually re-check. The AI knows when to look
-- (based on ads change history + expected data lag) and what to look for
-- (specific GA4 event / Ads geo report). This migration adds the columns
-- needed to store the monitoring spec + last check result.
--
-- A backend tick (in-process 6h interval + /monitor/tick endpoint) walks
-- pending observation steps where `check_after <= now`, evaluates the metric,
-- and either marks the step done (target met) or leaves it pending with an
-- updated last_check. When `check_until` passes without the target being met,
-- the tick marks the step 'failed' and drops an audit note so the AI can
-- add a follow-up on the next regen.
--
-- Safe to re-run: IF NOT EXISTS everywhere.

ALTER TABLE campaign_assistant_action_plan_steps
  ADD COLUMN IF NOT EXISTS monitor_spec JSONB,
  ADD COLUMN IF NOT EXISTS check_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS check_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_check_value JSONB,
  ADD COLUMN IF NOT EXISTS last_check_summary TEXT;

-- Partial index so the tick loop can efficiently find steps due for a check.
-- Only pending observation steps with a monitor_spec are candidates.
CREATE INDEX IF NOT EXISTS idx_ca_action_plan_steps_monitor_due
  ON campaign_assistant_action_plan_steps(check_after)
  WHERE monitor_spec IS NOT NULL AND status = 'pending';
