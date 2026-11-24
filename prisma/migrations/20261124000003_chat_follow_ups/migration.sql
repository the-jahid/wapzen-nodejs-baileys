CREATE TABLE "chat_follow_ups" (
    "phone_number_id" TEXT PRIMARY KEY REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "prompt" TEXT NOT NULL CHECK (char_length(btrim("prompt")) BETWEEN 1 AND 8000),
    "interval_hours" INTEGER NOT NULL CHECK ("interval_hours" BETWEEN 1 AND 8760),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "next_run_at" TIMESTAMPTZ,
    "requested_at" TIMESTAMPTZ,
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ,
    "last_run_at" TIMESTAMPTZ,
    "last_run_token" TEXT,
    "last_error" TEXT
);

CREATE TABLE "chat_follow_up_results" (
    "phone_number_id" TEXT NOT NULL REFERENCES "chat_follow_ups"("phone_number_id") ON DELETE CASCADE ON UPDATE CASCADE,
    "conversation_id" TEXT NOT NULL REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "run_token" TEXT NOT NULL,
    "status" TEXT NOT NULL CHECK ("status" IN ('skipped', 'draft', 'sending', 'sent', 'failed')),
    "reason" TEXT NOT NULL,
    "message" TEXT,
    "attempted_user_seq" INTEGER,
    "checked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("phone_number_id", "conversation_id")
);

CREATE INDEX "chat_follow_ups_enabled_next_run_at_idx" ON "chat_follow_ups" ("enabled", "next_run_at");
CREATE INDEX "chat_follow_ups_requested_at_idx" ON "chat_follow_ups" ("requested_at");
CREATE INDEX "chat_follow_up_results_run_idx" ON "chat_follow_up_results" ("phone_number_id", "run_token", "conversation_id");
CREATE INDEX "chat_follow_up_results_conversation_id_idx" ON "chat_follow_up_results" ("conversation_id");

ALTER TABLE "chat_follow_ups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_follow_up_results" ENABLE ROW LEVEL SECURITY;
