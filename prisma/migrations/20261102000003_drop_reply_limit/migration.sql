-- The reply limit is gone: nothing counts or caps AI replies any more.
ALTER TABLE "users"
    DROP COLUMN "ai_reply_count",
    DROP COLUMN "ai_reply_limit";

ALTER TABLE "chat_agents" DROP COLUMN "ai_reply_count";
