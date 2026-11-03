-- Per-agent switch for human handover: a person writing to a customer (from
-- the phone or the dashboard) turns the AI off for that customer. Starts on,
-- so every agent keeps doing what it did before the switch existed.
ALTER TABLE "chat_agents"
  ADD COLUMN "handover_enabled" BOOLEAN NOT NULL DEFAULT true;
