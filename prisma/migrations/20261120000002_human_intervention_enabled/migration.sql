-- Human intervention's own on/off switch. Off by default: the owner turns it
-- on once they've described when a person should step in. The WhatsApp number
-- became optional with it: without one, the agent flags the chat and turns
-- the AI off for that customer (human_intervention_pause_ai), sending nothing.
--
-- Safe while the previous instance still serves (see src/migrate.ts): it never
-- reads or writes this column. IF NOT EXISTS so it can be added ahead of the
-- deploy.
ALTER TABLE "chat_agents"
  ADD COLUMN IF NOT EXISTS "human_intervention_enabled" BOOLEAN NOT NULL DEFAULT false;
