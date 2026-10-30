-- The reply allowance moves from the chat agent to the account: an account has
-- one agent and deleting it must not hand back a fresh allowance. Replies
-- already sent count, and ai_reply_limit is raised per account on a paid plan.
ALTER TABLE "users"
    ADD COLUMN "ai_reply_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "ai_reply_limit" INTEGER NOT NULL DEFAULT 100,
    ADD CONSTRAINT "users_ai_reply_count_check" CHECK ("ai_reply_count" >= 0),
    ADD CONSTRAINT "users_ai_reply_limit_check" CHECK ("ai_reply_limit" >= 0);

UPDATE "users" u
SET "ai_reply_count" = sent."total"
FROM (
    SELECT "user_id", SUM("ai_reply_count")::INTEGER AS "total"
    FROM "chat_agents"
    GROUP BY "user_id"
) sent
WHERE sent."user_id" = u."id";
