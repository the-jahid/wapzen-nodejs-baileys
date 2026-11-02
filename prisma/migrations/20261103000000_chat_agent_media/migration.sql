-- Per-agent switches for answering voice messages and reading photos. Both
-- start off, so no agent changes behaviour until its owner turns one on.
ALTER TABLE "chat_agents"
  ADD COLUMN "voice_messages_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "images_enabled" BOOLEAN NOT NULL DEFAULT false;
