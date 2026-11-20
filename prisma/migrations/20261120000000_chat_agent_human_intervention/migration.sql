-- Human intervention: when a chat matches what the owner described, the agent
-- messages this WhatsApp number (from the agent's own number) so a person can
-- step in. Both stored as the owner typed them; blank means off, which is how
-- every agent starts.
--
-- Safe while the previous instance still serves (see src/migrate.ts): it never
-- reads or writes these columns. IF NOT EXISTS so it can be added ahead of the
-- deploy.
ALTER TABLE "chat_agents"
  ADD COLUMN IF NOT EXISTS "human_intervention_description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "human_intervention_phone" TEXT NOT NULL DEFAULT '';
