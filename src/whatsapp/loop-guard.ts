// Spots an agent stuck replying to another bot (another AI agent, an auto
// responder, or the same account's second number) and says when to stop.
//
// Two bots answer each other within seconds, forever, often with the same few
// words (on 2026-11-14 two agents of one account traded "😊" every 5 seconds,
// 190 messages an hour each). A person types slower, says different things,
// and rarely needs dozens of answers in a few minutes. So a chat trips when:
//   - speed: the last SPEED_RUN messages were each typed faster than a person
//     can: at least SPEED_MIN_CHARS characters, arriving at more than
//     SPEED_MAX_CPS characters a second counted from the agent's reply. Two AI
//     agents write each other long, ever-different messages within 2-4 s (a
//     live test of two Claude agents on 2026-11-19: 40-80 characters a second,
//     no repeats, so echo never tripped); a person thumbs 3-6. Only typed text
//     counts: a voice message (speech runs ~15 characters a second) or a photo
//     never does, nor a message sent before the agent's reply went out.
//   - echo: the last ECHO_RUN messages each came within FAST_MS of the agent's
//     previous reply, and they repeat themselves (few distinct texts, or the
//     same text the agent just sent), or
//   - flood: the agent answered it RATE_LIMIT times within RATE_WINDOW_MS,
//     whatever was said.
// Kept in memory per chat; a restart forgets it, which only means a loop runs
// a little longer before it trips again.

export const LOOP_FAST_MS = 20_000;
export const LOOP_ECHO_RUN = 6;
export const LOOP_RATE_LIMIT = 30;
export const LOOP_RATE_WINDOW_MS = 10 * 60_000;
export const LOOP_SPEED_RUN = 4;
export const LOOP_SPEED_MIN_CHARS = 30;
export const LOOP_SPEED_MAX_CPS = 10;
// Chats tracked at once; past this the one idle longest is dropped.
const MAX_CHATS = 5_000;

export type LoopReason = 'speed' | 'echo' | 'flood';

// How a message arrived, for the speed rule.
export type Arrival = {
  // When the person's (last) message reached this server; defaults to now.
  sentAt?: number;
  // False when it came with a voice message or photo: not typed.
  typed?: boolean;
};

type Incoming = {
  at: number;
  text: string;
  fast: boolean;
  echoed: boolean;
  superhuman: boolean;
};

type ChatTrack = {
  incoming: Incoming[];
  replies: number[];
  lastReply?: { at: number; text: string };
};

// Lowercase, no spaces or punctuation, so "Thanks!" and "thanks" are one text.
// Emoji stay, since a bot repeating 😊 is the pattern.
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s.,!?¡¿;:'"`~\-_*()[\]{}]+/gu, '')
    .trim();
}

export class LoopGuard {
  private readonly chats = new Map<string, ChatTrack>();

  constructor(
    private readonly opts = {
      fastMs: LOOP_FAST_MS,
      echoRun: LOOP_ECHO_RUN,
      rateLimit: LOOP_RATE_LIMIT,
      rateWindowMs: LOOP_RATE_WINDOW_MS,
      speedRun: LOOP_SPEED_RUN,
      speedMinChars: LOOP_SPEED_MIN_CHARS,
      speedMaxCps: LOOP_SPEED_MAX_CPS,
    },
  ) {}

  // A message arrived that the agent is about to answer. Returns why the chat
  // looks like a loop, or undefined to answer as usual. A tripped chat starts
  // over, so switching the AI back on gives it a clean slate.
  incoming(
    key: string,
    text: string,
    now = Date.now(),
    arrival: Arrival = {},
  ): LoopReason | undefined {
    const chat = this.track(key);
    const norm = normalize(text);
    const last = chat.lastReply;
    chat.incoming.push({
      at: now,
      text: norm,
      fast: !!last && now - last.at <= this.opts.fastMs,
      echoed: !!last && !!norm && normalize(last.text) === norm,
      superhuman: this.superhuman(
        text,
        last?.at,
        arrival.sentAt ?? now,
        arrival.typed ?? true,
      ),
    });
    const keep = Math.max(this.opts.echoRun, this.opts.speedRun);
    if (chat.incoming.length > keep) chat.incoming.shift();

    const reason = this.check(chat, now);
    if (reason) this.chats.delete(key);
    return reason;
  }

  // The agent's reply went out.
  replied(key: string, text: string, now = Date.now()) {
    const chat = this.track(key);
    chat.lastReply = { at: now, text };
    chat.replies.push(now);
    const since = now - this.opts.rateWindowMs;
    while (chat.replies.length && chat.replies[0] < since) chat.replies.shift();
  }

  forget(key: string) {
    this.chats.delete(key);
  }

  // Whether this message came faster than a person could have typed it after
  // reading the agent's reply.
  private superhuman(
    text: string,
    replyAt: number | undefined,
    sentAt: number,
    typed: boolean,
  ) {
    if (!typed || replyAt === undefined || sentAt <= replyAt) return false;
    const chars = [...text.trim()].length;
    if (chars < this.opts.speedMinChars) return false;
    return chars / ((sentAt - replyAt) / 1000) > this.opts.speedMaxCps;
  }

  private check(chat: ChatTrack, now: number): LoopReason | undefined {
    const since = now - this.opts.rateWindowMs;
    const recentReplies = chat.replies.filter((t) => t >= since).length;
    // This message would be the next reply.
    if (recentReplies + 1 > this.opts.rateLimit) return 'flood';

    const speedRun = chat.incoming.slice(-this.opts.speedRun);
    if (
      speedRun.length === this.opts.speedRun &&
      speedRun.every((m) => m.superhuman)
    ) {
      return 'speed';
    }

    const run = chat.incoming.slice(-this.opts.echoRun);
    if (run.length < this.opts.echoRun || !run.every((m) => m.fast)) return;
    const distinct = new Set(run.map((m) => m.text)).size;
    const echoes = run.filter((m) => m.echoed).length;
    if (distinct <= 2 || echoes >= run.length / 2) return 'echo';
  }

  private track(key: string): ChatTrack {
    let chat = this.chats.get(key);
    if (chat) {
      // Most recently used goes last, so the first is the one idle longest.
      this.chats.delete(key);
    } else {
      chat = { incoming: [], replies: [] };
      if (this.chats.size >= MAX_CHATS) {
        for (const oldest of this.chats.keys()) {
          this.chats.delete(oldest);
          break;
        }
      }
    }
    this.chats.set(key, chat);
    return chat;
  }
}
