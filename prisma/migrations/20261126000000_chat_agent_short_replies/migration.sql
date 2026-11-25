-- Agent Behavior > "Short replies": on, the agent answers in a line or two
-- like a person texting; off, it writes as long as it judges best. On by
-- default, and the DEFAULT also switches it on for every agent that already
-- exists (the owner's request).
--
-- Safe while the previous instance still serves (see src/migrate.ts): it never
-- reads or writes this column. IF NOT EXISTS so it can be added ahead of the
-- deploy.
ALTER TABLE "chat_agents"
  ADD COLUMN IF NOT EXISTS "short_replies" BOOLEAN NOT NULL DEFAULT true;
