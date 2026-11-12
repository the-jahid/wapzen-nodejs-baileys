-- The free trial grows from 100 to 200 AI replies (FREE_TRIAL_REPLIES).
-- Accounts stopped at 100 that are still under 200 are reopened, and their
-- inactive agents that have a number go live again (the trial was what turned
-- them off; a manual pause can't be told apart). Agents without a number stay
-- off. Accounts on a paid plan were never stamped and aren't touched.
--
-- Idempotent: during the deploy overlap the previous instance (still at 100)
-- can stamp a reopened account again, so this can be rerun by hand after.
WITH reopened AS (
  UPDATE "users" u SET "trial_ended_at" = NULL
  WHERE u."trial_ended_at" IS NOT NULL
    AND u."ai_reply_count" < 200
    AND (u."no_reply_limit_until" IS NULL OR u."no_reply_limit_until" <= now())
  RETURNING u.id
)
UPDATE "chat_agents" a SET "status" = 'active', "updated_at" = now()
FROM reopened r
WHERE a.user_id = r.id
  AND a.status = 'inactive'
  AND a.phone_number_id IS NOT NULL;
