-- Voice agents no longer pick a call direction (2026-11-21). Every agent
-- answers calls to its number and places calls from it, so the Go server stops
-- filtering on call_direction and the column goes. Dropping it also drops its
-- CHECK and idx_agents_phone_number_direction; idx_agents_phone_number_id still
-- serves the per-number lookup.
ALTER TABLE "agents" DROP COLUMN IF EXISTS "call_direction";
