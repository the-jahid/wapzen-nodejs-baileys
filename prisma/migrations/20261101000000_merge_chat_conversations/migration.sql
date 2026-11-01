-- One thread per contact, even after a number is removed and linked again.
--
-- A thread is keyed on (phone_number_id, peer_jid). Removing a number deletes
-- its phone_numbers row and sets its threads' phone_number_id to NULL; linking
-- it again makes a new row, so the same contact started a second thread, then
-- a third. Threads now remember the number they were on, and a number that
-- links takes back its old threads, merged into one per contact.

-- AlterTable
ALTER TABLE "chat_conversations" ADD COLUMN "former_phone_number" TEXT;

-- Notes the number on its threads before the foreign key's SET NULL forgets
-- which number they belonged to.
CREATE FUNCTION keep_chat_conversations_number() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.phone_number IS NOT NULL THEN
        UPDATE chat_conversations
        SET former_phone_number = OLD.phone_number
        WHERE phone_number_id = OLD.id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER phone_numbers_keep_chat_conversations
BEFORE DELETE ON phone_numbers
FOR EACH ROW EXECUTE FUNCTION keep_chat_conversations_number();

-- Moves every message of the source threads into the target thread, in the
-- order they were sent, then deletes the sources. Orders follow their thread.
-- A WhatsApp message saved on two of the threads is kept once.
CREATE FUNCTION merge_chat_conversations(target TEXT, sources TEXT[]) RETURNS VOID AS $$
DECLARE
    threads TEXT[];
BEGIN
    sources := array_remove(sources, target);
    IF cardinality(sources) = 0 THEN
        RETURN;
    END IF;
    threads := sources || target;

    DELETE FROM chat_messages m
    USING chat_messages k
    WHERE m.conversation_id = ANY(sources)
      AND m.wa_message_id IS NOT NULL
      AND k.wa_message_id = m.wa_message_id
      AND k.conversation_id = ANY(threads)
      AND k.id <> m.id
      AND (k.conversation_id = target OR k.id < m.id);

    -- Renumbered in two passes: the first lifts every seq clear of the old
    -- ones, so the unique (conversation_id, seq) index never sees two rows
    -- land on the same number halfway through.
    WITH ordered AS (
        SELECT m.id,
            row_number() OVER (ORDER BY m.created_at, c.created_at, m.seq) - 1 AS n
        FROM chat_messages m
        JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = ANY(threads)
    )
    UPDATE chat_messages m
    SET conversation_id = target, seq = 1000000000 + ordered.n
    FROM ordered
    WHERE m.id = ordered.id;

    UPDATE chat_messages SET seq = seq - 1000000000 WHERE conversation_id = target;

    UPDATE orders SET conversation_id = target WHERE conversation_id = ANY(sources);

    UPDATE chat_conversations t
    SET message_count = (SELECT count(*) FROM chat_messages WHERE conversation_id = target),
        last_message_role = (SELECT role FROM chat_messages
            WHERE conversation_id = target ORDER BY seq DESC LIMIT 1),
        last_message_at = (SELECT created_at FROM chat_messages
            WHERE conversation_id = target ORDER BY seq DESC LIMIT 1),
        chat_agent_id = COALESCE(t.chat_agent_id, s.chat_agent_id),
        peer_phone = COALESCE(t.peer_phone, s.peer_phone),
        peer_name = COALESCE(t.peer_name, s.peer_name),
        created_at = LEAST(t.created_at, s.created_at),
        updated_at = now()
    FROM (
        SELECT (array_agg(chat_agent_id ORDER BY created_at DESC)
                    FILTER (WHERE chat_agent_id IS NOT NULL))[1] AS chat_agent_id,
               (array_agg(peer_phone ORDER BY created_at DESC)
                    FILTER (WHERE peer_phone IS NOT NULL))[1] AS peer_phone,
               (array_agg(peer_name ORDER BY created_at DESC)
                    FILTER (WHERE peer_name IS NOT NULL))[1] AS peer_name,
               min(created_at) AS created_at
        FROM chat_conversations
        WHERE id = ANY(sources)
    ) s
    WHERE t.id = target;

    DELETE FROM chat_conversations WHERE id = ANY(sources);
END;
$$ LANGUAGE plpgsql;

-- Gives a linked number back the threads it had before it was removed, one
-- per contact. Threads removed before former_phone_number existed don't know
-- their number; they go to the account's number that links first.
CREATE FUNCTION adopt_chat_conversations(number_id TEXT) RETURNS VOID AS $$
DECLARE
    owner TEXT;
    number TEXT;
    peer RECORD;
    target TEXT;
BEGIN
    SELECT user_id, phone_number INTO owner, number
    FROM phone_numbers WHERE id = number_id;
    IF number IS NULL THEN
        RETURN;
    END IF;

    FOR peer IN
        SELECT peer_jid, array_agg(id ORDER BY created_at DESC) AS ids
        FROM chat_conversations
        WHERE user_id = owner
          AND phone_number_id IS NULL
          AND (former_phone_number = number OR former_phone_number IS NULL)
        GROUP BY peer_jid
    LOOP
        SELECT id INTO target FROM chat_conversations
        WHERE phone_number_id = number_id AND peer_jid = peer.peer_jid;
        IF target IS NULL THEN
            target := peer.ids[1];
            UPDATE chat_conversations
            SET phone_number_id = number_id, former_phone_number = NULL
            WHERE id = target;
        END IF;
        PERFORM merge_chat_conversations(target, peer.ids);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- The threads split up so far: each linked number takes back its contacts'
-- old threads, oldest number first. Threads whose number is gone for good are
-- still merged with each other, one per contact.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.id FROM phone_numbers p
        WHERE p.phone_number IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM chat_conversations c
              WHERE c.user_id = p.user_id AND c.phone_number_id IS NULL)
        ORDER BY p.created_at
    LOOP
        PERFORM adopt_chat_conversations(r.id);
    END LOOP;

    FOR r IN
        SELECT array_agg(id ORDER BY created_at DESC) AS ids
        FROM chat_conversations
        WHERE phone_number_id IS NULL
        GROUP BY user_id, peer_jid
        HAVING count(*) > 1
    LOOP
        PERFORM merge_chat_conversations(r.ids[1], r.ids);
    END LOOP;
END;
$$;
