// Human intervention: when a chat matches what the owner described
// (chat_agents.human_intervention_description), the agent calls call_human and
// its own number messages the owner's chosen number
// (human_intervention_phone) so a person can step in. With
// human_intervention_pause_ai on, a sent alert also turns the AI off for that
// customer (the Conversations page switch); otherwise the AI keeps answering.

import {
  type Detail,
  detailLines,
  DETAILS_SCHEMA,
  PASSED_ON_RULE,
} from './owner-send';

export const CALL_HUMAN_FUNCTION = 'call_human';

// The reason is the model's own words; this keeps a runaway one readable.
const MAX_REASON_CHARS = 500;
const MAX_QUOTE_CHARS = 500;

// One alert per chat in this window, however often the model asks: a customer
// still upset three messages later doesn't need three alerts. One that carries
// details the owner hasn't had yet (a second patient, a corrected age) still
// goes out, up to MAX_PER_WINDOW: held back, the owner never got them while the
// customer was told they were passed on (10 of 10 live).
export const HUMAN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_PER_WINDOW = 10;

export const CALL_HUMAN_PARAMETERS = {
  type: 'object' as const,
  properties: {
    reason: {
      type: 'string',
      description:
        'One or two sentences for the team: what the person needs and why a human should step in.',
    },
    details: DETAILS_SCHEMA,
  },
  required: ['reason'],
};

// What the agent can do in one chat when the owner has set this up.
export type ChatHumanHelp = {
  // When to bring a person in, as the owner wrote it.
  when: string;
  // Whether a sent alert turns the AI off for this customer.
  pausesAi: boolean;
  // Calls a person in: the alert to the owner's number when there is one, and
  // the AI off for this customer when pausesAi. 'recent' = this chat already
  // had a call within the cooldown, and this one brings no new details.
  call: (reason: string, details: Detail[]) => Promise<'sent' | 'recent'>;
};

// For the prompt: when to call and what to tell the person afterwards.
export function humanHelpPrompt(when: string, pausesAi = false): string {
  const after = pausesAi
    ? 'then tell the person that someone from the team has been told and will take over this chat here soon. That is your last message in this chat, so make it complete.'
    : 'then tell the person that someone from the team has been told and will get back to them here soon. Keep helping with anything you can meanwhile.';
  return [
    `You can bring in a person from the team with the ${CALL_HUMAN_FUNCTION} function. The owner wants that when: ${when.trim()}`,
    `Judge the person's latest message. When it matches that, call ${CALL_HUMAN_FUNCTION} straight away with a short reason, ${after} ` +
      `Don't call it for anything else, and never say a person has been told unless the function confirmed it.`,
    `When the owner wants it once the person has given certain information, call it the moment the last piece is in, however many messages that took, and not before: ask for what is missing. Put every piece they gave in details. Details are only for information the owner's words above name as something to collect (such as a name, age or address): when those words only describe a situation, such as an angry customer or a refund, leave details out and put everything in the reason. If they later correct one, or give the information for another person, call it again with the whole of it.`,
    PASSED_ON_RULE,
  ].join('\n');
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// The WhatsApp message the owner's number gets. Deterministic apart from the
// model's reason, so it always says who and how to reach them.
export function humanAlertNotice({
  agentName,
  customerName,
  customerPhone,
  reason,
  details = [],
  lastMessage,
  aiPaused = false,
}: {
  agentName: string;
  customerName?: string;
  customerPhone?: string | null;
  reason: string;
  // What the customer gave that the owner asked for.
  details?: Detail[];
  lastMessage: string;
  // The AI was turned off for this customer, so they wait for a person.
  aiPaused?: boolean;
}): string {
  const line = (label: string, value: string | null | undefined) =>
    value?.trim() ? `*${label}:* ${value.trim()}` : '';
  const digits = customerPhone?.replace(/\D/g, '') ?? '';
  const who = customerName?.trim() || customerPhone?.trim() || '';
  const blocks = [
    [
      '🙋 *A customer needs a person*',
      agentName.trim() ? `From ${agentName.trim()}` : '',
    ],
    [
      line('Customer', who),
      customerName?.trim() ? line('Phone', customerPhone) : '',
      digits ? `*Chat:* https://wa.me/${digits}` : '',
    ],
    detailLines(details),
    [line('Why', clip(reason.trim(), MAX_REASON_CHARS))],
    [
      lastMessage.trim()
        ? `*Their last message:*\n${clip(lastMessage.trim(), MAX_QUOTE_CHARS)}`
        : '',
    ],
    [
      aiPaused
        ? '_The AI has stopped replying to this customer. Turn it back on from Conversations in your dashboard._'
        : '_The AI is still replying to this customer._',
    ],
  ];
  return blocks
    .map((block) => block.filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

// Remembers when each chat last had an alert and what it carried, so the
// cooldown holds across replies. In memory: a restart at worst allows one extra
// alert.
export class HumanAlertLog {
  private readonly windows = new Map<
    string,
    { at: number; sent: Set<string> }
  >();

  // Claims the chat's alert, or false when it had one within the cooldown and
  // this one carries nothing new. content is detailsKey of what it carries, ''
  // when it carries no details.
  claim(key: string, now = Date.now(), content = ''): boolean {
    const open = this.windows.get(key);
    if (open && now - open.at < HUMAN_ALERT_COOLDOWN_MS) {
      if (!content || open.sent.has(content)) return false;
      if (open.sent.size >= MAX_PER_WINDOW) return false;
      open.sent.add(content);
      return true;
    }
    this.windows.set(key, { at: now, sent: new Set([content]) });
    if (this.windows.size > 5000) this.prune(now);
    return true;
  }

  // Whether the chat had anything within the cooldown.
  isOpen(key: string, now = Date.now()) {
    const open = this.windows.get(key);
    return !!open && now - open.at < HUMAN_ALERT_COOLDOWN_MS;
  }

  // Whether the chat's open window already carried exactly this.
  has(key: string, content: string) {
    return this.windows.get(key)?.sent.has(content) ?? false;
  }

  // A failed send gives the claim back, so the next try isn't blocked.
  release(key: string, content = '') {
    const open = this.windows.get(key);
    open?.sent.delete(content);
    if (!open?.sent.size) this.windows.delete(key);
  }

  private prune(now: number) {
    for (const [key, { at }] of this.windows) {
      if (now - at >= HUMAN_ALERT_COOLDOWN_MS) this.windows.delete(key);
    }
  }
}
