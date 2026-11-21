-- Remove public API keys (2026-11-21). The voice dashboard and the Go server's
-- routes authenticate with the signed-in Clerk session only; nothing issues or
-- reads API keys any more. Dropping the table also drops its indexes and its
-- foreign key to users.
DROP TABLE IF EXISTS "api_keys";
