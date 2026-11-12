-- Free trial: a free account gets FREE_TRIAL_REPLIES (100) AI replies in all,
-- counted per account so deleting and recreating the agent can't reset it.
-- When they're used up, trial_ended_at is stamped and every agent of the
-- account goes inactive; the dashboard then shows the paid-plan card. An
-- account on a paid plan (no_reply_limit_until in the future) is never
-- counted or stopped.
--
-- Additive and idempotent: the previous instance never reads these columns,
-- and the file can be run by hand ahead of the deploy.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ai_reply_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "trial_ended_at" TIMESTAMPTZ;

-- Replies sent before counting began. An AI reply is saved as 'assistant' with
-- no WhatsApp message id; what the owner types on the phone carries one.
-- Dashboard sends also have none, so this can count a few of those too.
UPDATE "users" u SET "ai_reply_count" = c.n
FROM (
  SELECT cc.user_id, count(*)::int AS n
  FROM chat_messages m
  JOIN chat_conversations cc ON cc.id = m.conversation_id
  WHERE m.role = 'assistant' AND m.wa_message_id IS NULL
  GROUP BY cc.user_id
) c
WHERE c.user_id = u.id AND u.ai_reply_count < c.n;

UPDATE "users" SET "trial_ended_at" = now()
WHERE "trial_ended_at" IS NULL
  AND "ai_reply_count" >= 100
  AND ("no_reply_limit_until" IS NULL OR "no_reply_limit_until" <= now());

UPDATE "chat_agents" a SET "status" = 'inactive', "updated_at" = now()
FROM "users" u
WHERE u.id = a.user_id
  AND a.status = 'active'
  AND u.trial_ended_at IS NOT NULL
  AND (u.no_reply_limit_until IS NULL OR u.no_reply_limit_until <= now());
