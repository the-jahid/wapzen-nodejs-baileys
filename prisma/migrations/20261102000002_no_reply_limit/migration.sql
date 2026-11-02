-- No account has a reply limit any more, existing or new. The limit is set to
-- the largest int instead of dropped, so the limit checks never fire.

-- Agents the limit stopped get turned back on first, while the old limits
-- still say which accounts were at theirs. Only agents with a number, since an
-- active agent needs one.
UPDATE "chat_agents" a
SET "status" = 'active', "updated_at" = now()
FROM "users" u
WHERE a."user_id" = u."id"
  AND a."status" = 'inactive'
  AND a."phone_number_id" IS NOT NULL
  AND u."ai_reply_count" >= u."ai_reply_limit";

ALTER TABLE "users" ALTER COLUMN "ai_reply_limit" SET DEFAULT 2147483647;

UPDATE "users" SET "ai_reply_limit" = 2147483647;
