-- Voice call minutes per account (2026-11-21). Every account gets 10 free
-- minutes (600 seconds) of voice agent calls; more are bought by message and
-- added by hand by raising limit_seconds. used_seconds is a counter rather than
-- a sum over calls, because a user can delete calls from their history and that
-- must not hand the minutes back. The Go voice server adds each answered call's
-- duration here in the same statement that ends the call.
--
-- No row means nothing used yet and the default 600-second allowance; the Go
-- server creates the row on the first call that ends. Voice-only: it shares
-- nothing with chat but users.id.
CREATE TABLE IF NOT EXISTS "voice_usage" (
  "user_id"       TEXT        NOT NULL,
  "used_seconds"  INTEGER     NOT NULL DEFAULT 0,
  "limit_seconds" INTEGER     NOT NULL DEFAULT 600,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "voice_usage_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "voice_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "voice_usage_used_seconds_check" CHECK ("used_seconds" >= 0),
  CONSTRAINT "voice_usage_limit_seconds_check" CHECK ("limit_seconds" >= 0)
);
