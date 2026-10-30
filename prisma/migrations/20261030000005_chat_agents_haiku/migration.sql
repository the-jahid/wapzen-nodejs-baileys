-- Chat agents answer with Claude Haiku 4.5 (Go migration 00062). Existing
-- rows move onto it and the column default follows.
UPDATE "chat_agents" SET "model_name" = 'claude-haiku-4-5' WHERE "model_name" <> 'claude-haiku-4-5';

ALTER TABLE "chat_agents" ALTER COLUMN "model_name" SET DEFAULT 'claude-haiku-4-5';
