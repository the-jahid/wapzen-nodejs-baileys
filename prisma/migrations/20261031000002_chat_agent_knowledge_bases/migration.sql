-- Which knowledge bases a chat agent answers from, ported from the Go server.
-- Deleting either side removes the row. Purely additive: migrations land while
-- the old instance still serves.

-- CreateTable
CREATE TABLE "chat_agent_knowledge_bases" (
    "chat_agent_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_agent_knowledge_bases_pkey" PRIMARY KEY ("chat_agent_id","knowledge_base_id")
);

-- CreateIndex
CREATE INDEX "chat_agent_knowledge_bases_knowledge_base_id_idx" ON "chat_agent_knowledge_bases"("knowledge_base_id");

-- AddForeignKey
ALTER TABLE "chat_agent_knowledge_bases" ADD CONSTRAINT "chat_agent_knowledge_bases_chat_agent_id_fkey" FOREIGN KEY ("chat_agent_id") REFERENCES "chat_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_agent_knowledge_bases" ADD CONSTRAINT "chat_agent_knowledge_bases_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
