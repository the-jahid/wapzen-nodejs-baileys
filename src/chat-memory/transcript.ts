import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { answerText, withoutNoteBrackets } from '../whatsapp/reply-notes';

// How a chat's saved messages (chat_messages) become what the agent remembers.
// Only @langchain/core is used here, so Jest can load it.

export type TranscriptRow = {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  at: Date;
};

// The saved messages one reply starts from: the latest of this agent's own in
// this chat, oldest first.
export type Transcript = {
  // Missing on a contact's first message: there's no thread yet.
  conversationId?: string;
  rows: TranscriptRow[];
};

// A chat's thread in the memory store. By conversation, so deleting one in the
// dashboard starts fresh; and by agent, so an agent only ever remembers its own
// chat.
export const threadIdFor = (conversationId: string, chatAgentId: string) =>
  `${conversationId}:${chatAgentId}`;

const ROW_PREFIX = 'm:';
export const SUMMARY_ID = 'summary';

// What the agent is shown of a saved message. A reply saved before
// 2026-11-28 may hold a note of the model's own ("[Reply in Egyptian Arabic]
// ..."), and a chat that has one gets more of them: the model copies its own
// earlier turns. It isn't shown them.
const shownText = (row: TranscriptRow) =>
  row.role === 'assistant' ? withoutNoteBrackets(row.text) : row.text;

// Each saved message keeps one id wherever it goes, so the same message read
// twice is one message, and the order is the order it was saved in.
export function rowMessage(row: TranscriptRow): BaseMessage {
  const fields = { id: `${ROW_PREFIX}${row.seq}`, content: shownText(row) };
  return row.role === 'user' ? new HumanMessage(fields) : new AIMessage(fields);
}

export function rowSeq(message: BaseMessage): number | undefined {
  if (!message.id?.startsWith(ROW_PREFIX)) return undefined;
  const seq = Number(message.id.slice(ROW_PREFIX.length));
  return Number.isInteger(seq) ? seq : undefined;
}

// A message with no text would be refused by the model.
export const rowMessages = (rows: TranscriptRow[]) =>
  rows.filter((row) => shownText(row).trim()).map(rowMessage);

// What stays in memory after a reply: the summary and the saved messages. The
// message being answered and the model's own working (its thinking, tool calls,
// a photo, the draft) go; what was really sent comes back as a saved message.
export const isRemembered = (message: BaseMessage) =>
  message.id === SUMMARY_ID || rowSeq(message) !== undefined;

// The remembered messages in order, without those the summary already covers.
export function orderedMemory(
  messages: BaseMessage[],
  summarizedThrough: number,
): BaseMessage[] {
  const summary = messages.filter((m) => m.id === SUMMARY_ID);
  const rows = new Map<number, BaseMessage>();
  for (const message of messages) {
    const seq = rowSeq(message);
    if (seq !== undefined && seq > summarizedThrough) rows.set(seq, message);
  }
  return [
    ...summary.slice(-1),
    ...[...rows].sort(([a], [b]) => a - b).map(([, message]) => message),
  ];
}

export const lastSeq = (messages: BaseMessage[], least: number) =>
  messages.reduce((max, m) => Math.max(max, rowSeq(m) ?? max), least);

// The reply one run wrote: the text of its last model call, the one after the
// tool calls. What the model writes alongside a tool call is mostly about the
// call ("Let me check.", and in a Kazakh chat "The client is asking about this
// car, I should ask which one"), and it used to be sent along with the answer
// (2026-11-28). It is sent only when the last call wrote nothing, so a reply
// that went out with a tool call still reaches the person.
export function replyText(messages: BaseMessage[], incomingId?: string) {
  const at = messages.findIndex((m) => m.id === incomingId);
  const calls = messages
    .slice(at + 1)
    .filter((message) => AIMessage.isInstance(message));
  const last = calls.at(-1);
  const answer =
    last && !(last as AIMessage).tool_calls?.length ? answerText(last) : '';
  if (answer) return answer;
  return calls.map(answerText).filter(Boolean).join('\n\n');
}

const HOUR_MS = 3_600_000;

// A line telling the agent the person is back after a while, or '' within a
// day: a "hi" three weeks later isn't an answer to the last question.
export function gapNote(lastAt: Date | undefined, now: Date): string {
  if (!lastAt) return '';
  const hours = (now.getTime() - lastAt.getTime()) / HOUR_MS;
  if (!(hours >= 24)) return '';
  const days = Math.floor(hours / 24);
  return `The message before this one in this chat was ${days} ${days === 1 ? 'day' : 'days'} ago.`;
}
