-- Saved WhatsApp text threads, ported from the Go server's migration 00054.
--
-- A thread is keyed on (phone_number_id, peer_jid), not on the agent: swapping
-- which agent answers a number is a change of staff, not a new conversation.
-- chat_agent_id records who answered last. Deleting the number or the agent
-- keeps the history (SET NULL); deleting the user deletes it (CASCADE).

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "chat_agent_id" TEXT,
    "peer_jid" TEXT NOT NULL,
    "peer_phone" TEXT,
    "peer_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_role" TEXT,
    "last_message_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "conversation_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "wa_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_conversations_user_id_last_message_at_idx" ON "chat_conversations"("user_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "chat_conversations_chat_agent_id_idx" ON "chat_conversations"("chat_agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_conversation_id_seq_key" ON "chat_messages"("conversation_id", "seq");

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_chat_agent_id_fkey" FOREIGN KEY ("chat_agent_id") REFERENCES "chat_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written below: Prisma's schema can't express these.

-- CHECK constraints from the Go server.
ALTER TABLE "chat_conversations"
    ADD CONSTRAINT "chat_conversations_peer_jid_check" CHECK (char_length("peer_jid") > 0),
    ADD CONSTRAINT "chat_conversations_peer_name_check" CHECK ("peer_name" IS NULL OR char_length("peer_name") <= 120),
    ADD CONSTRAINT "chat_conversations_status_check" CHECK ("status" IN ('open', 'closed')),
    ADD CONSTRAINT "chat_conversations_message_count_check" CHECK ("message_count" >= 0),
    ADD CONSTRAINT "chat_conversations_last_message_role_check" CHECK ("last_message_role" IS NULL OR "last_message_role" IN ('user', 'assistant'));
ALTER TABLE "chat_messages"
    ADD CONSTRAINT "chat_messages_seq_check" CHECK ("seq" >= 0),
    ADD CONSTRAINT "chat_messages_role_check" CHECK ("role" IN ('user', 'assistant'));

-- One thread per number and contact. Partial, because a thread whose number
-- was deleted keeps its history but can never be written to again.
CREATE UNIQUE INDEX "chat_conversations_phone_number_id_peer_jid_key"
    ON "chat_conversations"("phone_number_id", "peer_jid")
    WHERE "phone_number_id" IS NOT NULL;

-- Keeps a WhatsApp redelivery out of the transcript.
CREATE UNIQUE INDEX "chat_messages_conversation_id_wa_message_id_key"
    ON "chat_messages"("conversation_id", "wa_message_id")
    WHERE "wa_message_id" IS NOT NULL;

-- The thread's summary follows its messages, whichever code path appended
-- them, so the two can't drift.
CREATE FUNCTION sync_chat_conversation_summary() RETURNS TRIGGER AS $$
BEGIN
    UPDATE chat_conversations
    SET message_count = message_count + 1,
        last_message_role = NEW.role,
        last_message_at = NEW.created_at,
        updated_at = now()
    WHERE id = NEW.conversation_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_messages_sync_conversation
AFTER INSERT ON chat_messages
FOR EACH ROW EXECUTE FUNCTION sync_chat_conversation_summary();
