-- The free trial goes from 200 back to 400 AI replies (FREE_TRIAL_REPLIES).
-- Free accounts stopped under 400 are reopened. Their agents are switched back
-- on separately, only those the 200 limit had switched off, so an agent its
-- owner had paused stays off. Accounts on a paid plan aren't touched.
--
-- Run after the deploy: the previous instance (still at 200) would stop a
-- reopened account again at its next message. Idempotent.
UPDATE "users" SET "trial_ended_at" = NULL
WHERE "trial_ended_at" IS NOT NULL
  AND "ai_reply_count" < 400
  AND ("no_reply_limit_until" IS NULL OR "no_reply_limit_until" <= now());
