-- Each chat agent answers at most 50 group messages an hour, across all its
-- groups. Counted apart from hourly_reply_count, with its own window, so a busy
-- group can use up its own allowance without silencing private chats.
ALTER TABLE "chat_agents"
  ADD COLUMN "group_hourly_reply_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "group_hourly_window_started_at" TIMESTAMPTZ;
