-- Order taking: the orders table, the per-agent settings, and the built-in
-- Take Order tool every account has. Everything here is additive, because it
-- lands while the previous instance is still serving (see src/migrate.ts).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "last_order_number" INTEGER NOT NULL DEFAULT 1000;

-- AlterTable
ALTER TABLE "chat_agents"
    ADD COLUMN "order_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "order_instructions" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "tools"
    ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "key" TEXT;

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "conversation_id" TEXT,
    "order_number" INTEGER NOT NULL,
    "customer_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "description" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "delivery_address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "channel" TEXT NOT NULL DEFAULT 'chat',
    "internal_note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tools_user_id_key_key" ON "tools"("user_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "orders_user_id_order_number_key" ON "orders"("user_id", "order_number");

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_user_id_status_idx" ON "orders"("user_id", "status");

-- CreateIndex
CREATE INDEX "orders_conversation_id_created_at_idx" ON "orders"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "chat_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written below: Prisma's schema can't express these.

ALTER TABLE "orders"
    ADD CONSTRAINT "orders_status_check" CHECK ("status" IN ('new', 'confirmed', 'processing', 'completed', 'cancelled')),
    ADD CONSTRAINT "orders_channel_check" CHECK ("channel" IN ('chat', 'voice'));

-- The built-in tool is named for people, not for the model: it reaches the
-- model as create_order, so its name doesn't need the function-name pattern.
-- A name with a capital and a space also can't clash with any existing tool.
ALTER TABLE "tools" DROP CONSTRAINT "tools_type_check";
ALTER TABLE "tools" ADD CONSTRAINT "tools_type_check" CHECK ("type" IN ('api_request', 'send_text', 'order'));
ALTER TABLE "tools" DROP CONSTRAINT "tools_tool_name_check";
ALTER TABLE "tools" ADD CONSTRAINT "tools_tool_name_check" CHECK ("type" = 'order' OR "tool_name" ~ '^[a-z][a-z0-9_]{0,63}$');

-- Users are created in three places (the Clerk webhook, the auth guard and the
-- import script), so the tool is added here rather than in each of them.
CREATE FUNCTION add_take_order_tool() RETURNS trigger AS $$
BEGIN
    INSERT INTO tools (user_id, type, tool_name, description, is_system, "key")
    VALUES (NEW.id, 'order', 'Take Order',
        'Lets an agent take orders from customers during a conversation and save them under Orders.',
        true, 'take_order')
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_add_take_order_tool
    AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION add_take_order_tool();

-- Every account that already exists.
INSERT INTO tools (user_id, type, tool_name, description, is_system, "key")
SELECT id, 'order', 'Take Order',
    'Lets an agent take orders from customers during a conversation and save them under Orders.',
    true, 'take_order'
FROM users
ON CONFLICT DO NOTHING;
