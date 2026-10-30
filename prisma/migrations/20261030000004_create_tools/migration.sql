-- Tools and their attachment to chat agents, ported from the Go server's
-- migrations 00042 + 00053. A tool row only defines the action; it is offered
-- in a chat once a chat agent attaches it through chat_agent_tools. Chat only:
-- end_call and transfer_call release a phone call, so they are not stored here.

-- CreateTable
CREATE TABLE "tools" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_agent_tools" (
    "chat_agent_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_agent_tools_pkey" PRIMARY KEY ("chat_agent_id","tool_id")
);

-- CreateIndex
CREATE INDEX "tools_user_id_idx" ON "tools"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tools_user_id_tool_name_key" ON "tools"("user_id", "tool_name");

-- CreateIndex
CREATE INDEX "chat_agent_tools_tool_id_idx" ON "chat_agent_tools"("tool_id");

-- AddForeignKey
ALTER TABLE "tools" ADD CONSTRAINT "tools_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_agent_tools" ADD CONSTRAINT "chat_agent_tools_chat_agent_id_fkey" FOREIGN KEY ("chat_agent_id") REFERENCES "chat_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_agent_tools" ADD CONSTRAINT "chat_agent_tools_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written below: Prisma's schema can't express these.

-- CHECK constraints from the Go server. The name pattern is the intersection
-- of what OpenAI and Anthropic accept as a function name.
ALTER TABLE "tools"
    ADD CONSTRAINT "tools_type_check" CHECK ("type" IN ('api_request', 'send_text')),
    ADD CONSTRAINT "tools_tool_name_check" CHECK ("tool_name" ~ '^[a-z][a-z0-9_]{0,63}$'),
    ADD CONSTRAINT "tools_description_check" CHECK (char_length("description") BETWEEN 1 AND 1000);
