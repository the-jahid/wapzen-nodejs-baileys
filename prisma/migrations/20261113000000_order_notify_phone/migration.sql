-- A WhatsApp number the agent tells about each order it places or changes,
-- from the agent's own number. Optional: blank means no one is told, which is
-- how every agent starts. Stored as the owner typed it.
--
-- Safe while the previous instance still serves (see src/migrate.ts): it never
-- reads or writes this column. IF NOT EXISTS so it can be added ahead of the
-- deploy.
ALTER TABLE "chat_agents"
  ADD COLUMN IF NOT EXISTS "order_notify_phone" TEXT NOT NULL DEFAULT '';
