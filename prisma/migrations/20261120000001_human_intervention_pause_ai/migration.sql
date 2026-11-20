-- Human intervention: whether a successful alert also turns the AI off for
-- that customer (chat_conversations.ai_reply_enabled), so a person takes over,
-- and flags the conversation red (needs_attention) until the AI is back on.
-- On by default, the owner's choice; it does nothing until the description and
-- number are filled in.
--
-- Safe while the previous instance still serves (see src/migrate.ts): it never
-- reads or writes this column. IF NOT EXISTS so it can be added ahead of the
-- deploy.
ALTER TABLE "chat_agents"
  ADD COLUMN IF NOT EXISTS "human_intervention_pause_ai" BOOLEAN NOT NULL DEFAULT true;
