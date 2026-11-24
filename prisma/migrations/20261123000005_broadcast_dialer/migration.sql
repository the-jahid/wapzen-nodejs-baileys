-- Broadcast auto-dialer (2026-11-23): every contact added to a broadcast is
-- queued, and the Go server's dialer calls queued contacts one after another
-- from the broadcast agent's WhatsApp number. A broadcast can be paused (by
-- the user, or by the dialer itself when the number/agent/minutes stop it,
-- with paused_reason saying why).
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "paused_reason" TEXT;

-- Contacts that already exist are NOT queued ('idle'): adding the column must
-- not start ringing people. New contacts default to 'queued'.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'broadcast_contacts' AND column_name = 'call_status'
  ) THEN
    ALTER TABLE "broadcast_contacts" ADD COLUMN "call_status" TEXT NOT NULL DEFAULT 'idle';
    ALTER TABLE "broadcast_contacts" ALTER COLUMN "call_status" SET DEFAULT 'queued';
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE "broadcast_contacts" ADD CONSTRAINT "broadcast_contacts_call_status_check"
    CHECK ("call_status" IN ('idle', 'queued', 'calling', 'answered', 'no_answer', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "broadcast_contacts" ADD COLUMN IF NOT EXISTS "queued_at" TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE "broadcast_contacts" ADD COLUMN IF NOT EXISTS "last_call_id" TEXT;
ALTER TABLE "broadcast_contacts" ADD COLUMN IF NOT EXISTS "last_error" TEXT;
DO $$ BEGIN
  ALTER TABLE "broadcast_contacts" ADD CONSTRAINT "broadcast_contacts_last_call_id_fkey"
    FOREIGN KEY ("last_call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- The dialer's work list: queued/calling contacts in queue order.
CREATE INDEX IF NOT EXISTS "idx_broadcast_contacts_dialer" ON "broadcast_contacts"("call_status", "queued_at")
  WHERE "call_status" IN ('queued', 'calling');
