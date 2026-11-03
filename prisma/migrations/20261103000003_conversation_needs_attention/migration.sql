-- A conversation the AI stopped answering shows red in the dashboard until a
-- person marks it done. The database raises the flag, so every way the AI
-- goes off (a person writing from the phone or the dashboard, the switch)
-- and every message the customer sends while it is off is caught alike.
ALTER TABLE "chat_conversations"
  ADD COLUMN "needs_attention" BOOLEAN NOT NULL DEFAULT false;

-- The ones already handed over before this existed.
UPDATE "chat_conversations" SET "needs_attention" = true
WHERE NOT "ai_reply_enabled";

-- The AI going off for a contact.
CREATE FUNCTION flag_chat_conversation_ai_off() RETURNS TRIGGER AS $$
BEGIN
    IF NOT NEW.ai_reply_enabled
       AND (TG_OP = 'INSERT' OR OLD.ai_reply_enabled) THEN
        NEW.needs_attention = true;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_conversations_flag_ai_off
BEFORE INSERT OR UPDATE OF ai_reply_enabled ON chat_conversations
FOR EACH ROW EXECUTE FUNCTION flag_chat_conversation_ai_off();

-- The customer writing while nobody but a person will answer them. Same
-- summary update as before, plus the flag.
CREATE OR REPLACE FUNCTION sync_chat_conversation_summary() RETURNS TRIGGER AS $$
BEGIN
    UPDATE chat_conversations
    SET message_count = message_count + 1,
        last_message_role = NEW.role,
        last_message_at = NEW.created_at,
        needs_attention = needs_attention
            OR (NEW.role = 'user' AND NOT ai_reply_enabled),
        updated_at = now()
    WHERE id = NEW.conversation_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
