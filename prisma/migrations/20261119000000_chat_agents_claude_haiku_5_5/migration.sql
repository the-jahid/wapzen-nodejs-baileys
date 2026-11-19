-- Chat agents answer with Anthropic's Claude Haiku 5.5. Existing rows move onto
-- it and the column defaults follow.
UPDATE "chat_agents" SET "model_provider" = 'anthropic', "model_name" = 'claude-haiku-5-5';

ALTER TABLE "chat_agents" ALTER COLUMN "model_provider" SET DEFAULT 'anthropic';
ALTER TABLE "chat_agents" ALTER COLUMN "model_name" SET DEFAULT 'claude-haiku-5-5';
