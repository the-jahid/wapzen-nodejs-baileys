-- Images and documents agents send to customers (src/agent-files), moved here
-- from the separate files database on 2026-11-17. The rows were copied before
-- this deploy, so the table may already exist: IF NOT EXISTS throughout.
-- No foreign keys, as before: ownership is checked in the controller and
-- removing an agent or user removes its files by hand.
--
-- Safe while the previous instance still serves (see src/migrate.ts): it never
-- touches this table.
CREATE TABLE IF NOT EXISTS "agent_files" (
  "id"            TEXT        NOT NULL DEFAULT (gen_random_uuid())::text,
  "user_id"       TEXT        NOT NULL,
  "chat_agent_id" TEXT        NOT NULL,
  "file_name"     TEXT        NOT NULL,
  "mime_type"     TEXT        NOT NULL,
  "size_bytes"    INTEGER     NOT NULL,
  "description"   TEXT        NOT NULL,
  "data"          BYTEA       NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "agent_files_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_files_agent_idx" ON "agent_files" ("chat_agent_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_files_user_idx" ON "agent_files" ("user_id");
-- Supabase's public API must not read the files.
ALTER TABLE "agent_files" ENABLE ROW LEVEL SECURITY;
