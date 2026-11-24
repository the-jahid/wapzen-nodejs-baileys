-- The free trial goes from 400 back to 200 AI replies (FREE_TRIAL_REPLIES).
-- Free accounts that have already used 200 are stopped: trial_ended_at is
-- stamped and their active agents go inactive, as when the last reply is sent.
-- Accounts on a paid plan aren't touched, and nothing is deleted.
--
-- Idempotent. No rerun is needed after the deploy: an account that passes 200
-- on the previous instance (still at 400) is stopped at its next message.
WITH stopped AS (
  UPDATE "users" u SET "trial_ended_at" = now()
  WHERE u."trial_ended_at" IS NULL
    AND u."ai_reply_count" >= 200
    AND (u."no_reply_limit_until" IS NULL OR u."no_reply_limit_until" <= now())
  RETURNING u.id
)
UPDATE "chat_agents" a SET "status" = 'inactive', "updated_at" = now()
FROM stopped s
WHERE a.user_id = s.id
  AND a.status = 'active';
