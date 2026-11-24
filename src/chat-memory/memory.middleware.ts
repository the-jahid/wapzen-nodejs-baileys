import {
  HumanMessage,
  RemoveMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { createMiddleware, summarizationMiddleware } from 'langchain';
import { z } from 'zod';
import {
  isRemembered,
  lastSeq,
  orderedMemory,
  replyText,
  rowMessages,
  rowSeq,
  SUMMARY_ID,
  type TranscriptRow,
} from './transcript';

// The saved messages older than the ones a reply brings, when there are any:
// load reads those after one seq and before beforeSeq, oldest first.
export type OlderMessages = {
  beforeSeq: number;
  load: (afterSeq: number) => Promise<TranscriptRow[]>;
};

// How many messages a chat with no memory store is answered from.
export const MESSAGES_WITHOUT_MEMORY = 40;
// The most one chat carries word for word, whatever happens to its summaries.
export const MAX_MESSAGES = 400;

const memoryState = z.object({
  // The last saved message the thread has.
  syncedSeq: z.number().default(-1),
  // The last saved message the summary covers.
  summarizedThrough: z.number().default(-1),
  // What the run answered, for the caller.
  reply: z.string().default(''),
});

const replaceAll = (messages: BaseMessage[]) => [
  new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
  ...messages,
];

// Short-term memory. chat_messages is the record of what was really said, so a
// thread never keeps its own version: before a reply it takes in whatever was
// saved since the last one (the last turn, what a person sent from the dashboard
// or the phone, what came while the AI was off), and after it lets go of the
// run's own messages. So a restart, a failed send or a rewritten reply can't
// leave the agent remembering something the customer never saw.
export const chatTranscript = createMiddleware({
  name: 'ChatTranscript',
  stateSchema: memoryState,
  contextSchema: z.object({
    incomingId: z.string().optional(),
    older: z.custom<OlderMessages>().optional(),
  }),
  beforeAgent: async (state, runtime) => {
    const { incomingId, older } = runtime.context;
    const { messages, summarizedThrough = -1, syncedSeq = -1 } = state;
    const incoming = messages.filter((m) => m.id === incomingId);
    let memory = orderedMemory(messages, summarizedThrough);
    let caughtUp = true;
    if (!runtime.configurable?.thread_id) {
      // No store: nothing is kept, so nothing is worth summing up either.
      memory = memory.slice(-MESSAGES_WITHOUT_MEMORY);
    } else if (older && older.beforeSeq > syncedSeq + 1) {
      // The caller brings the latest messages; a thread that is further behind
      // (never opened before, or the AI was off for a long talk) reads the rest.
      // If that fails the next reply tries again.
      const missed = await older.load(syncedSeq).catch(() => undefined);
      caughtUp = !!missed;
      memory = orderedMemory(
        [...memory, ...rowMessages(missed ?? [])],
        summarizedThrough,
      );
    }
    if (memory.length > MAX_MESSAGES) {
      const summary = memory.filter((m) => m.id === SUMMARY_ID);
      memory = [...summary, ...memory.slice(summary.length - MAX_MESSAGES)];
    }
    return {
      messages: replaceAll([...memory, ...incoming]),
      syncedSeq: caughtUp ? lastSeq(memory, syncedSeq) : syncedSeq,
      reply: '',
    };
  },
  afterAgent: (state, runtime) => ({
    reply: replyText(state.messages, runtime.context.incomingId),
    messages: replaceAll(state.messages.filter(isRemembered)),
  }),
});

// LangChain's summarization, with two things a saved memory needs. A summary
// that failed is dropped and the messages stay for the next reply to try again:
// on its own the middleware replaces them with the error text, which would then
// be saved for good. And the thread notes how far the summary reaches, so a
// message it covers is never taken in again.
export function chatSummary(
  options: Parameters<typeof summarizationMiddleware>[0],
) {
  const { beforeModel } = summarizationMiddleware(options);
  // Its hook reads only the messages, whatever else the state holds.
  const summarize = (
    typeof beforeModel === 'function' ? beforeModel : beforeModel?.hook
  ) as (
    state: unknown,
    runtime: unknown,
  ) => Promise<{ messages?: BaseMessage[] } | undefined>;
  return createMiddleware({
    name: 'ChatSummary',
    stateSchema: memoryState,
    beforeModel: async (state, runtime) => {
      const update = await summarize(state, runtime);
      const [, summary, ...kept] = update?.messages ?? [];
      if (!summary || !isGoodSummary(summary.text, options.summaryPrefix)) {
        return;
      }
      const keptSeqs = new Set(kept.map(rowSeq));
      const dropped = state.messages.filter((m) => !keptSeqs.has(rowSeq(m)));
      return {
        messages: replaceAll([summaryMessage(summary.text), ...kept]),
        summarizedThrough: lastSeq(dropped, state.summarizedThrough ?? -1),
      };
    },
  });
}

export const summaryMessage = (text: string) =>
  new HumanMessage({
    id: SUMMARY_ID,
    content: text,
    additional_kwargs: { lc_source: 'summarization' },
  });

const FAILED_SUMMARIES = [
  'Error generating summary',
  'Previous conversation was too long to summarize',
  'No previous conversation history',
];

export function isGoodSummary(text: string, prefix = '') {
  const notes = text.replace(prefix, '').trim();
  return !!notes && !FAILED_SUMMARIES.some((fail) => notes.startsWith(fail));
}
