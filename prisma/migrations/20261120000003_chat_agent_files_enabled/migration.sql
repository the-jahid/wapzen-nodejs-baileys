-- An on/off switch for Images & Files: off, the agent sends none of the
-- owner's uploaded files (they stay uploaded). On by default, which is how
-- every agent has behaved so far.
--
-- Safe while the previous instance still serves (see src/migrate.ts): it never
-- reads or writes this column. IF NOT EXISTS so it can be added ahead of the
-- deploy.
ALTER TABLE "chat_agents"
  ADD COLUMN IF NOT EXISTS "files_enabled" BOOLEAN NOT NULL DEFAULT true;
