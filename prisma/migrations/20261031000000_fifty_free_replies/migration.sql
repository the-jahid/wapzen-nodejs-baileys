-- The free allowance drops from 100 replies to 50, for existing accounts too.
-- An account raised for a paid plan keeps its own limit.
ALTER TABLE "users" ALTER COLUMN "ai_reply_limit" SET DEFAULT 50;

UPDATE "users" SET "ai_reply_limit" = 50 WHERE "ai_reply_limit" = 100;
