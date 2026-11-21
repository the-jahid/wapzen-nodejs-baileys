-- Lift the maintenance pause on voice agents (2026-11-21). The
-- agents_force_paused trigger (Go migration 00061, recreated by
-- 20261121000000_voice_agents) forced status = 'inactive' on every write, so
-- an agent could never go live: connecting a number or pressing Activate saved
-- it as paused, and the call lookup (status = 'active') found no agent, so
-- inbound calls were never answered. Agents paused by it stay paused until
-- their owner activates them again.
DROP TRIGGER IF EXISTS "agents_force_paused" ON "agents";
DROP FUNCTION IF EXISTS force_agent_paused();
