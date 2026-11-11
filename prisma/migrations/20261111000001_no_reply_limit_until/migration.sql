-- An account can be let off the hourly AI reply limits until a given time,
-- set by hand (UPDATE users SET no_reply_limit_until = ... WHERE email = ...).
-- Null means the normal limits.
--
-- Safe while the previous instance still serves (see src/migrate.ts): it never
-- reads or writes this column. IF NOT EXISTS so it can be added ahead of the
-- deploy.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "no_reply_limit_until" TIMESTAMPTZ;
