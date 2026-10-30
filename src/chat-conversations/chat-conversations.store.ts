import type { ChatConversation } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

// Writes to chat_conversations / chat_messages that both the reply path
// (ChatResponderService) and the API need. Plain functions rather than a
// provider, so the WhatsApp module can record turns without importing the
// module that sends through it.

// One exchange to save: the message that arrived and the reply that went
// back. assistantMessage is empty when the agent said nothing, which still
// records that the message arrived.
export type NewChatTurn = {
  userId: string;
  phoneNumberId: string;
  chatAgentId?: string;
  peerJid: string;
  peerPhone?: string;
  peerName?: string;
  waMessageId?: string;
  userMessage: string;
  assistantMessage?: string;
};

type Db = Pick<PrismaService, '$queryRaw'>;

const MAX_PEER_NAME = 120;

// Saves one exchange, opening the thread the first time a contact writes to
// a number. The thread is found by (phone_number_id, peer_jid), so it outlives
// a change of agent; chat_agent_id moves to whoever replied. A message whose
// WhatsApp id is already on the thread (a redelivery) is skipped. It is all
// one statement, so a reply is never saved without its question, and it's
// one round trip to the database instead of six (an interactive transaction
// holds a pooled connection for every trip, while replies to other people
// wait for one).
export async function recordChatTurn(prisma: PrismaService, turn: NewChatTurn) {
  const waMessageId = turn.waMessageId || null;
  const reply = turn.assistantMessage?.trim() ? turn.assistantMessage : null;
  await prisma.$executeRaw`
    WITH conv AS (
      INSERT INTO chat_conversations
        (user_id, phone_number_id, chat_agent_id, peer_jid, peer_phone, peer_name)
      VALUES (${turn.userId}, ${turn.phoneNumberId}, ${turn.chatAgentId || null},
        ${turn.peerJid}, ${turn.peerPhone || null},
        ${turn.peerName?.trim().slice(0, MAX_PEER_NAME) || null})
      ON CONFLICT (phone_number_id, peer_jid) WHERE phone_number_id IS NOT NULL
      DO UPDATE SET
        chat_agent_id = COALESCE(EXCLUDED.chat_agent_id, chat_conversations.chat_agent_id),
        peer_phone = COALESCE(EXCLUDED.peer_phone, chat_conversations.peer_phone),
        peer_name = COALESCE(EXCLUDED.peer_name, chat_conversations.peer_name),
        updated_at = now()
      RETURNING id
    ),
    -- The thread to append to, unless this WhatsApp message is already on it.
    thread AS (
      SELECT conv.id,
        (SELECT COALESCE(MAX(seq) + 1, 0) FROM chat_messages
         WHERE conversation_id = conv.id) AS next_seq
      FROM conv
      WHERE ${waMessageId}::text IS NULL OR NOT EXISTS (
        SELECT 1 FROM chat_messages
        WHERE conversation_id = conv.id AND wa_message_id = ${waMessageId}::text)
    )
    INSERT INTO chat_messages (conversation_id, seq, role, content, wa_message_id)
    SELECT thread.id, thread.next_seq + t.ord, t.role, t.content, t.wa_message_id
    FROM thread,
      (VALUES (0, 'user', ${turn.userMessage}::text, ${waMessageId}::text),
              (1, 'assistant', ${reply}::text, NULL)) AS t(ord, role, content, wa_message_id)
    WHERE t.content IS NOT NULL
    ORDER BY t.ord`;
}

// Adds one message at the end of a thread. seq is worked out inside the
// INSERT, so two writers can't both pick the same one quietly: the unique
// (conversation_id, seq) index rejects the second. The trigger updates the
// thread's message_count and last_message_*.
export async function appendMessage(
  db: Db,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  waMessageId?: string,
) {
  const [row] = await db.$queryRaw<
    { seq: number; role: string; content: string; createdAt: Date }[]
  >`
    INSERT INTO chat_messages (conversation_id, seq, role, content, wa_message_id)
    SELECT ${conversationId}, COALESCE(MAX(seq) + 1, 0), ${role}, ${content},
      ${waMessageId || null}
    FROM chat_messages
    WHERE conversation_id = ${conversationId}
    RETURNING seq, role, content, created_at AS "createdAt"`;
  return row;
}

// Fills in peer_phone for "@lid" contacts, whose messages arrive without a
// phone number. Baileys learns the LID → number mapping later and keeps it in
// the number's auth state ("lid-mapping-<lid>_reverse"), so it's looked up at
// read time instead of being frozen into the row — the Go server does the
// same with whatsmeow_lid_map.
export async function resolvePeerPhones<T extends ChatConversation>(
  prisma: PrismaService,
  rows: T[],
): Promise<T[]> {
  const keyOf = (row: T) =>
    !row.peerPhone && row.phoneNumberId && row.peerJid.endsWith('@lid')
      ? `lid-mapping-${row.peerJid.slice(0, -'@lid'.length).split(':')[0]}_reverse`
      : null;

  const wanted = rows.filter((row) => keyOf(row));
  if (wanted.length === 0) return rows;

  const found = await prisma.whatsAppAuth.findMany({
    where: {
      OR: wanted.map((row) => ({
        phoneNumberId: row.phoneNumberId!,
        key: keyOf(row)!,
      })),
    },
  });
  const phones = new Map<string, string>();
  for (const { phoneNumberId, key, value } of found) {
    try {
      const user = JSON.parse(value) as unknown;
      if (typeof user === 'string' && user) {
        phones.set(`${phoneNumberId}|${key}`, `+${user}`);
      }
    } catch {
      // A malformed row just leaves the phone unknown.
    }
  }
  return rows.map((row) => {
    const phone = phones.get(`${row.phoneNumberId}|${keyOf(row)}`);
    return phone ? { ...row, peerPhone: phone } : row;
  });
}
