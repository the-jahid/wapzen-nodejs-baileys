-- Each chat agent answers at most 100 messages an hour. The hour starts with
-- the first reply after the last one ran out; the count lives here so every
-- instance (and a restart) sees the same window.
ALTER TABLE "chat_agents"
  ADD COLUMN "hourly_reply_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hourly_window_started_at" TIMESTAMPTZ;
