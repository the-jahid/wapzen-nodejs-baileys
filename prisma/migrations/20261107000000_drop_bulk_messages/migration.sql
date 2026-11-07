-- The bulk message feature is gone, and the owner asked for everything it saved
-- to be deleted on 2026-11-07: message templates, sends and their contact lists.
-- This can't be undone.
--
-- The previous instance still runs its bulk sender while this lands (see
-- src/migrate.ts). It only logs the failed queries until it shuts down, and nothing
-- else uses these tables. No CASCADE, so anything that did depend on them would
-- fail the migration instead of being dropped with them.

DROP TABLE IF EXISTS "bulk_recipients";
DROP TABLE IF EXISTS "bulk_campaigns";
DROP TABLE IF EXISTS "message_templates";
