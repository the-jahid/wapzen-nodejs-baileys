-- Voice broadcasts (2026-11-23): a user creates as many as they like, each
-- with one of their voice agents selected. agent_id is required when a
-- broadcast is created (enforced by the Go server, which checks ownership) and
-- goes NULL if that agent is later deleted.
CREATE TABLE IF NOT EXISTS "broadcasts" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agent_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "broadcasts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "broadcasts_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "broadcasts_name_check" CHECK (char_length("name") >= 1 AND char_length("name") <= 80)
);
CREATE INDEX IF NOT EXISTS "idx_broadcasts_user_id" ON "broadcasts"("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_broadcasts_agent_id" ON "broadcasts"("agent_id") WHERE "agent_id" IS NOT NULL;
