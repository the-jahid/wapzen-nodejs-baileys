-- Remove the outbound campaigns feature (2026-11-23). The Broadcast page will
-- be rebuilt as a new feature later; nothing of the old campaigns is kept.
DROP TRIGGER IF EXISTS "calls_sync_campaign_progress_insert" ON "calls";
DROP TRIGGER IF EXISTS "calls_sync_campaign_progress_update" ON "calls";
DROP TRIGGER IF EXISTS "campaign_leads_sync_count" ON "campaign_leads";
DROP FUNCTION IF EXISTS sync_campaign_call_progress();
DROP FUNCTION IF EXISTS sync_outbound_campaign_leads_count();

DROP INDEX IF EXISTS "idx_calls_campaign_created";
DROP INDEX IF EXISTS "idx_calls_lead_id";
ALTER TABLE "calls" DROP CONSTRAINT IF EXISTS "calls_campaign_id_fkey";
ALTER TABLE "calls" DROP CONSTRAINT IF EXISTS "calls_lead_id_fkey";
ALTER TABLE "calls" DROP COLUMN IF EXISTS "campaign_id";
ALTER TABLE "calls" DROP COLUMN IF EXISTS "lead_id";

DROP TABLE IF EXISTS "campaign_leads";
DROP TABLE IF EXISTS "outbound_campaigns";
