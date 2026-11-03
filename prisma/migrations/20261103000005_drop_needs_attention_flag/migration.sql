-- The red "needs you" flag is removed: nothing raises it any more and every
-- conversation is cleared. The column stays (always false) so an instance
-- still running the old code doesn't fail mid-deploy; drop it later.
DROP TRIGGER IF EXISTS chat_conversations_flag_ai_off ON chat_conversations;
DROP FUNCTION IF EXISTS flag_chat_conversation_ai_off();

-- Back to the summary update from before the flag.
CREATE OR REPLACE FUNCTION sync_chat_conversation_summary() RETURNS TRIGGER AS $$
BEGIN
    UPDATE chat_conversations
    SET message_count = message_count + 1,
        last_message_role = NEW.role,
        last_message_at = NEW.created_at,
        updated_at = now()
    WHERE id = NEW.conversation_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

UPDATE chat_conversations SET needs_attention = false WHERE needs_attention;
