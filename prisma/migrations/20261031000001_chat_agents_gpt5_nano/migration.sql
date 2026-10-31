-- Chat agents answer with OpenAI's GPT-5 nano. Existing rows move onto it and
-- the column defaults follow.
UPDATE "chat_agents" SET "model_provider" = 'openai', "model_name" = 'gpt-5-nano';

ALTER TABLE "chat_agents" ALTER COLUMN "model_provider" SET DEFAULT 'openai';
ALTER TABLE "chat_agents" ALTER COLUMN "model_name" SET DEFAULT 'gpt-5-nano';
