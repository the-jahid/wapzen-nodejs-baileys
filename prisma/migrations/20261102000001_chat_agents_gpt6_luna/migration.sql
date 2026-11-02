-- Chat agents answer with OpenAI's GPT-6 Luna. Existing rows move onto it and
-- the column default follows.
UPDATE "chat_agents" SET "model_provider" = 'openai', "model_name" = 'gpt-6-luna';

ALTER TABLE "chat_agents" ALTER COLUMN "model_name" SET DEFAULT 'gpt-6-luna';
