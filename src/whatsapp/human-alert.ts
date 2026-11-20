// Human intervention: when a chat matches what the owner described
// (chat_agents.human_intervention_description), the agent calls call_human and
// its own number messages the owner's chosen number
// (human_intervention_phone) so a person can step in. With
// human_intervention_pause_ai on, a sent alert also turns the AI off for that
// customer (the Conversations page switch); otherwise the AI keeps answering.

export const CALL_HUMAN_FUNCTION = 'call_human';

// The reason is the model's own words; this keeps a runaway one readable.
const MAX_REASON_CHARS = 500;
const MAX_QUOTE_CHARS = 500;

// One alert per chat in this window, however often the model asks: a customer
// still upset three messages later doesn't need three alerts.
export const HUMAN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

export const CALL_HUMAN_PARAMETERS = {
  type: 'object' as const,
  properties: {
    reason: {
      type: 'string',
      description:
        'One or two sentences for the team: what the person needs and why a human should step in.',
    },
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
  // had a call within the cooldown.
  call: (reason: string) => Promise<'sent' | 'recent'>;
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
  lastMessage,
  aiPaused = false,
}: {
  agentName: string;
  customerName?: string;
  customerPhone?: string | null;
  reason: string;
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

// Remembers when each chat last had an alert, so the cooldown holds across
// replies. In memory: a restart at worst allows one extra alert.
export class HumanAlertLog {
  private readonly sentAt = new Map<string, number>();

  // Claims the chat's alert, or false when it had one within the cooldown.
  claim(key: string, now = Date.now()): boolean {
    const last = this.sentAt.get(key);
    if (last !== undefined && now - last < HUMAN_ALERT_COOLDOWN_MS) {
      return false;
    }
    this.sentAt.set(key, now);
    if (this.sentAt.size > 5000) this.prune(now);
    return true;
  }

  // A failed send gives the claim back, so the next try isn't blocked.
  release(key: string) {
    this.sentAt.delete(key);
  }

  private prune(now: number) {
    for (const [key, at] of this.sentAt) {
      if (now - at >= HUMAN_ALERT_COOLDOWN_MS) this.sentAt.delete(key);
    }
  }
}
