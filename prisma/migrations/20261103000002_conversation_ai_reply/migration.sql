-- A person can switch the AI off for one contact and answer them by hand.
-- The contact's messages are still saved; only the agent stays quiet.
ALTER TABLE "chat_conversations"
  ADD COLUMN "ai_reply_enabled" BOOLEAN NOT NULL DEFAULT true;
