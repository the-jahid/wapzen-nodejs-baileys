-- Calls placed from a broadcast contact (2026-11-23): the dashboard's contact
-- panel lists only these. Set by the Go server when POST /v1/dashboard/calls
-- carries broadcast_contact_id; goes NULL if the contact is deleted.
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "broadcast_contact_id" TEXT;
DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_broadcast_contact_id_fkey"
    FOREIGN KEY ("broadcast_contact_id") REFERENCES "broadcast_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "idx_calls_broadcast_contact_id" ON "calls"("broadcast_contact_id", "created_at" DESC) WHERE "broadcast_contact_id" IS NOT NULL;
