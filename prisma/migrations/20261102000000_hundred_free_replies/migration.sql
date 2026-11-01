-- The free allowance goes up from 50 replies to 100, for existing accounts too.
-- An account raised for a paid plan keeps its own limit.
ALTER TABLE "users" ALTER COLUMN "ai_reply_limit" SET DEFAULT 100;

UPDATE "users" SET "ai_reply_limit" = 100 WHERE "ai_reply_limit" = 50;

-- Accounts that used up the old 50 and still have replies left get their
-- agents back. Only agents with a number are turned on, since an active agent
-- needs one. The 50 cap is the only thing that kept these accounts' agents off
-- (stopAtLimit stops all of them, and Activate was refused at the limit).
UPDATE "chat_agents" a
SET "status" = 'active', "updated_at" = now()
FROM "users" u
WHERE a."user_id" = u."id"
  AND a."status" = 'inactive'
  AND a."phone_number_id" IS NOT NULL
  AND u."ai_reply_limit" = 100
  AND u."ai_reply_count" >= 50
  AND u."ai_reply_count" < u."ai_reply_limit";
