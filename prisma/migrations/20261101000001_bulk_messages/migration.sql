-- Bulk messages: saved message templates, and sends of one templated message
-- to a list of people, one message every interval_seconds. Everything here is
-- additive, because it lands while the previous instance is still serving
-- (see src/migrate.ts).

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_campaigns" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "interval_seconds" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'running',
    "total_count" INTEGER NOT NULL,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "next_send_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_recipients" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "campaign_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "phone" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "sent_at" TIMESTAMPTZ,

    CONSTRAINT "bulk_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_templates_user_id_created_at_idx" ON "message_templates"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bulk_campaigns_user_id_created_at_idx" ON "bulk_campaigns"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bulk_campaigns_status_next_send_at_idx" ON "bulk_campaigns"("status", "next_send_at");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_recipients_campaign_id_position_key" ON "bulk_recipients"("campaign_id", "position");

-- CreateIndex
CREATE INDEX "bulk_recipients_campaign_id_status_position_idx" ON "bulk_recipients"("campaign_id", "status", "position");

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_campaigns" ADD CONSTRAINT "bulk_campaigns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_campaigns" ADD CONSTRAINT "bulk_campaigns_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_recipients" ADD CONSTRAINT "bulk_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "bulk_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written below: Prisma's schema can't express these.

ALTER TABLE "bulk_campaigns"
    ADD CONSTRAINT "bulk_campaigns_status_check" CHECK ("status" IN ('running', 'paused', 'completed', 'cancelled')),
    ADD CONSTRAINT "bulk_campaigns_interval_check" CHECK ("interval_seconds" BETWEEN 10 AND 3600);

ALTER TABLE "bulk_recipients"
    ADD CONSTRAINT "bulk_recipients_status_check" CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'skipped'));

-- One send at a time per number: two running at once would halve the gap
-- between its messages, which is what the interval is there to stop.
CREATE UNIQUE INDEX "bulk_campaigns_one_running_per_number"
    ON "bulk_campaigns"("phone_number_id") WHERE "status" = 'running';
