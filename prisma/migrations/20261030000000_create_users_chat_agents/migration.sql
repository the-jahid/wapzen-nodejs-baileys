-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "email" TEXT NOT NULL,
    "oauth_id" TEXT NOT NULL,
    "username" TEXT,
    "blocked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_agents" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "model_provider" TEXT NOT NULL DEFAULT 'anthropic',
    "model_name" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "model_temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "prompt_system_prompt" TEXT NOT NULL DEFAULT 'You are a helpful, friendly WhatsApp chat assistant.',
    "ai_reply_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_agents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_oauth_id_key" ON "users"("oauth_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_agents_phone_number_id_key" ON "chat_agents"("phone_number_id");

-- CreateIndex
CREATE INDEX "chat_agents_user_id_idx" ON "chat_agents"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_agents_user_id_agent_name_key" ON "chat_agents"("user_id", "agent_name");

-- AddForeignKey
ALTER TABLE "chat_agents" ADD CONSTRAINT "chat_agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CHECK constraints from the Go server (Prisma schema can't express these).
ALTER TABLE "chat_agents"
    ADD CONSTRAINT "chat_agents_status_check" CHECK ("status" IN ('active', 'inactive')),
    ADD CONSTRAINT "chat_agents_model_provider_check" CHECK ("model_provider" IN ('openai', 'anthropic')),
    ADD CONSTRAINT "chat_agents_model_temperature_check" CHECK ("model_temperature" BETWEEN 0.1 AND 1.0),
    ADD CONSTRAINT "chat_agents_ai_reply_count_check" CHECK ("ai_reply_count" >= 0),
    ADD CONSTRAINT "chat_agents_active_requires_phone" CHECK ("status" <> 'active' OR "phone_number_id" IS NOT NULL);
