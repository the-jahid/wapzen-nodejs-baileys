-- A chat agent can read its owner's website while it replies: the address,
-- and whether reading it is on. Off and blank to start, so no agent changes
-- behaviour until its owner sets one.
--
-- Safe while the previous instance still serves (see src/migrate.ts): it never
-- reads or writes these columns. IF NOT EXISTS so it can be added ahead of
-- the deploy.
ALTER TABLE "chat_agents"
  ADD COLUMN IF NOT EXISTS "website_url" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "website_enabled" BOOLEAN NOT NULL DEFAULT false;
