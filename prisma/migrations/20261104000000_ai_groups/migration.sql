-- The WhatsApp groups an owner switched the AI on in. A group with no row here
-- is off, so every group starts off, and a number removed takes its switches
-- with it. Additive, because it lands while the previous instance is still
-- serving (see src/migrate.ts).

-- CreateTable
CREATE TABLE "ai_groups" (
    "phone_number_id" TEXT NOT NULL,
    "group_jid" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_groups_pkey" PRIMARY KEY ("phone_number_id", "group_jid")
);

-- AddForeignKey
ALTER TABLE "ai_groups" ADD CONSTRAINT "ai_groups_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
