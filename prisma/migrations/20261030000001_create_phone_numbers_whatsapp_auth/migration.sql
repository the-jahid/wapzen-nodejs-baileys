-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "phone_number" TEXT,
    "label" TEXT,
    "wa_jid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_qr',
    "qr_code" TEXT,
    "last_connected_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_auth" (
    "phone_number_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_auth_pkey" PRIMARY KEY ("phone_number_id","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_wa_jid_key" ON "phone_numbers"("wa_jid");

-- CreateIndex
CREATE INDEX "phone_numbers_user_id_idx" ON "phone_numbers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_user_id_phone_number_key" ON "phone_numbers"("user_id", "phone_number");

-- AddForeignKey
ALTER TABLE "chat_agents" ADD CONSTRAINT "chat_agents_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_auth" ADD CONSTRAINT "whatsapp_auth_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CHECK constraints from the Go server (Prisma schema can't express these).
ALTER TABLE "phone_numbers"
    ADD CONSTRAINT "phone_numbers_status_check" CHECK ("status" IN ('pending_qr', 'connected', 'disconnected')),
    ADD CONSTRAINT "phone_numbers_phone_number_check" CHECK ("phone_number" IS NULL OR "phone_number" ~ '^\+[1-9][0-9]{1,14}$'),
    ADD CONSTRAINT "phone_numbers_label_check" CHECK ("label" IS NULL OR char_length("label") <= 80);
