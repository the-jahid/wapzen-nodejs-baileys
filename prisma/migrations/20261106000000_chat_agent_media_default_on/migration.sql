-- New chat agents answer voice messages and read photos unless their owner turns
-- that off. Only the default changes: existing agents keep the setting they have.
ALTER TABLE "chat_agents"
  ALTER COLUMN "voice_messages_enabled" SET DEFAULT true,
  ALTER COLUMN "images_enabled" SET DEFAULT true;
