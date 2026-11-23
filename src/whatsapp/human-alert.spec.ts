import type { ConfigService } from '@nestjs/config';
import { activity } from '../activity/activity';
import type { AgentFilesService } from '../agent-files/agent-files.service';
import { parseInput, validateUpdate } from '../chat-agents/chat-agents.types';
import { parseUpdate } from '../chat-conversations/chat-conversations.types';
import type { IndexerService } from '../knowledge-bases/indexer.service';
import type { OrdersService } from '../orders/orders.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ensureConversation } from '../chat-conversations/chat-conversations.store';
import { ChatToolbox } from '../tools/chat-toolbox';
import {
  ChatResponderService,
  type IncomingChat,
} from './chat-responder.service';
import {
  CALL_HUMAN_FUNCTION,
  type ChatHumanHelp,
  HUMAN_ALERT_COOLDOWN_MS,
  HumanAlertLog,
  humanAlertNotice,
} from './human-alert';

// Human intervention: the API fields, the alert text, the call_human tool and
// when the agent's number messages the owner's chosen number.

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../knowledge-bases/indexer.service', () => ({
  IndexerService: class {},
}));
jest.mock('../orders/orders.service', () => ({ OrdersService: class {} }));
jest.mock('../activity/activity');
// No language set: the reply language guard never rewrites here.
jest.mock('./reply-language', () => ({
  createLanguageGuard: () => ({
    languageOf: () => Promise.resolve(''),
    inLanguage: (text: string) => Promise.resolve({ text, rewritten: false }),
  }),
}));
jest.mock('./reply-agent', () => ({
  CHAT_REMEMBER_MESSAGES: 40,
  CHAT_SUMMARY_AT: 50,
  isChatSummary: () => false,
  createConfirmationCheck: () => () => Promise.resolve(undefined),
  createReplyAgent: () => ({}),
}));
jest.mock('../chat-conversations/chat-conversations.store', () => ({
  resolvePeerPhones: (_: unknown, rows: unknown[]) => Promise.resolve(rows),
  ensureConversation: jest.fn(() => Promise.resolve('thread-1')),
}));

describe('human_intervention on the API', () => {
  it('is accepted as its own section and counts as a change', () => {
    const input = parseInput({
      human_intervention: {
        human_intervention_description: 'The customer asks for a refund',
        human_intervention_phone: '+8801711111111',
      },
    });
    expect(input.human_intervention).toEqual({
      human_intervention_description: 'The customer asks for a refund',
      human_intervention_phone: '+8801711111111',
    });
    expect(() => validateUpdate(input)).not.toThrow();
    expect(() =>
      validateUpdate({
        human_intervention: { human_intervention_phone: '' },
      }),
    ).not.toThrow();
  });

  it('refuses wrong types and overlong values', () => {
    expect(() =>
      parseInput({ human_intervention: { human_intervention_phone: 1 } }),
    ).toThrow();
    expect(() =>
      parseInput({ human_intervention: { something_else: 'x' } }),
    ).toThrow();
    expect(() =>
      validateUpdate({
        human_intervention: { human_intervention_phone: '1'.repeat(41) },
      }),
    ).toThrow();
    expect(() =>
      validateUpdate({
        human_intervention: {
          human_intervention_description: 'a'.repeat(1001),
        },
      }),
    ).toThrow();
  });
});

describe('the alert text', () => {
  it('names the customer, links the chat and quotes the reason and message', () => {
    const text = humanAlertNotice({
      agentName: 'Dhaka Bites',
      customerName: 'Rahim',
      customerPhone: '+8801722222222',
      reason: 'Wants a refund for a cold burger',
      lastMessage: 'I want my money back',
    });
    expect(text).toBe(
      [
        '🙋 *A customer needs a person*\nFrom Dhaka Bites',
        '*Customer:* Rahim\n*Phone:* +8801722222222\n*Chat:* https://wa.me/8801722222222',
        '*Why:* Wants a refund for a cold burger',
        '*Their last message:*\nI want my money back',
        '_The AI is still replying to this customer._',
      ].join('\n\n'),
    );
  });

  it('works with only an @lid chat and no number', () => {
    const text = humanAlertNotice({
      agentName: 'Bot',
      customerPhone: null,
      reason: 'x'.repeat(900),
      lastMessage: '',
    });
    expect(text).not.toContain('wa.me');
    expect(text).not.toContain('last message');
    expect(text).toContain('…');
  });
});

describe('HumanAlertLog', () => {
  it('allows one alert per chat in the cooldown, and again after it', () => {
    const log = new HumanAlertLog();
    expect(log.claim('a', 0)).toBe(true);
    expect(log.claim('a', 1000)).toBe(false);
    expect(log.claim('b', 1000)).toBe(true);
    expect(log.claim('a', HUMAN_ALERT_COOLDOWN_MS)).toBe(true);
    log.release('a');
    expect(log.claim('a', HUMAN_ALERT_COOLDOWN_MS + 1)).toBe(true);
  });
});

describe('call_human in the toolbox', () => {
  const help = (
    call: ChatHumanHelp['call'],
    pausesAi = false,
  ): ChatHumanHelp => ({
    when: 'the customer is angry',
    pausesAi,
    call,
  });

  it('is offered only when set up, with the owner’s words in the prompt', () => {
    expect(ChatToolbox.for([], 'agent-1', () => Promise.resolve())).toBeNull();
    const box = ChatToolbox.for(
      [],
      'agent-1',
      () => Promise.resolve(),
      undefined,
      [],
      undefined,
      help(() => Promise.resolve('sent')),
    )!;
    expect(box.definitions().map((d) => d.function.name)).toEqual([
      CALL_HUMAN_FUNCTION,
    ]);
    expect(box.humanHelpPrompt).toContain('the customer is angry');
    expect(box.humanHelpPrompt).toContain('Keep helping');
  });

  it('tells the model it is handing over when the AI will pause', async () => {
    const box = ChatToolbox.for(
      [],
      'agent-1',
      () => Promise.resolve(),
      undefined,
      [],
      undefined,
      help(() => Promise.resolve('sent'), true),
    )!;
    expect(box.humanHelpPrompt).toContain('take over this chat');
    expect(await box.run(CALL_HUMAN_FUNCTION, { reason: 'x' })).toContain(
      'will not reply in this chat again',
    );
  });

  it('calls once per reply and reports each outcome to the model', async () => {
    const call = jest.fn(() => Promise.resolve('sent' as const));
    const box = ChatToolbox.for(
      [],
      'agent-1',
      () => Promise.resolve(),
      undefined,
      [],
      undefined,
      help(call),
    )!;
    const [first, second] = await Promise.all([
      box.run(CALL_HUMAN_FUNCTION, { reason: 'angry' }),
      box.run(CALL_HUMAN_FUNCTION, { reason: 'still angry' }),
    ]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('angry');
    expect(first).toContain('has been told');
    expect(second).toBe(first);
  });

  it('says so when it fails, and can try again', async () => {
    const call = jest
      .fn<Promise<'sent' | 'recent'>, [string]>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('recent');
    const box = ChatToolbox.for(
      [],
      'agent-1',
      () => Promise.resolve(),
      undefined,
      [],
      undefined,
      help(call),
    )!;
    expect(await box.run(CALL_HUMAN_FUNCTION, {})).toContain(
      'could not be reached',
    );
    expect(await box.run(CALL_HUMAN_FUNCTION, {})).toContain('already told');
  });
});

describe('the responder’s human help', () => {
  function setup(
    agentOverrides: Record<string, unknown>,
    chatOverrides: Partial<IncomingChat> = {},
  ) {
    const update = jest.fn(() => Promise.resolve({}));
    const responder = new ChatResponderService(
      { chatConversation: { update } } as unknown as PrismaService,
      { get: () => 'key' } as unknown as ConfigService,
      { enabled: false } as unknown as IndexerService,
      {} as OrdersService,
      {} as AgentFilesService,
    );
    const sendTo = jest.fn(() => Promise.resolve());
    const chat: IncomingChat = {
      phoneNumberId: 'number-1',
      peerJid: '8801722222222@s.whatsapp.net',
      peerPhone: '+8801722222222',
      peerName: 'Rahim',
      text: 'I want a refund',
      send: () => Promise.resolve(),
      sendTo,
      sendFile: () => Promise.resolve(),
      setTyping: () => Promise.resolve(),
      ...chatOverrides,
    };
    const agent = {
      id: 'agent-1',
      userId: 'user-1',
      agentName: 'Dhaka Bites',
      humanInterventionEnabled: true,
      humanInterventionDescription: 'The customer asks for a refund',
      humanInterventionPhone: '01711-111111',
      phoneNumber: { phoneNumber: '+8801700000000' },
      user: { email: 'owner@example.com' },
      ...agentOverrides,
    };
    const helpFor = () =>
      (
        responder as unknown as {
          humanHelpFor(
            a: unknown,
            c: IncomingChat,
          ): Promise<ChatHumanHelp | undefined>;
        }
      ).humanHelpFor(agent, chat);
    return { sendTo, helpFor, update };
  }

  beforeEach(() => jest.clearAllMocks());

  it('messages the owner’s number, local numbers included, once per chat', async () => {
    const { sendTo, helpFor, update } = setup({});
    const help = (await helpFor())!;
    expect(help.when).toBe('The customer asks for a refund');
    expect(await help.call('Refund for order #1003')).toBe('sent');
    expect(sendTo).toHaveBeenCalledWith(
      '+8801711111111',
      expect.stringContaining('*Why:* Refund for order #1003'),
    );
    expect(activity).toHaveBeenCalledWith(
      'human alert sent: owner@example.com - Dhaka Bites',
    );
    // The next message in the same chat gets a new toolbox, not a new alert.
    expect(await (await helpFor())!.call('again')).toBe('recent');
    expect(sendTo).toHaveBeenCalledTimes(1);
    // The AI stays on unless the owner chose otherwise.
    expect(update).not.toHaveBeenCalled();
    expect(sendTo).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('still replying'),
    );
  });

  it('turns the AI off for that customer after the alert when asked to', async () => {
    const { sendTo, helpFor, update } = setup({
      humanInterventionPauseAi: true,
    });
    const help = (await helpFor())!;
    expect(help.pausesAi).toBe(true);
    expect(await help.call('Refund')).toBe('sent');
    expect(ensureConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        phoneNumberId: 'number-1',
        peerJid: '8801722222222@s.whatsapp.net',
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 'thread-1' },
      data: { aiReplyEnabled: false, needsAttention: true },
    });
    expect(sendTo).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('stopped replying'),
    );
  });

  it('is off while its switch is off', async () => {
    expect(
      await setup({ humanInterventionEnabled: false }).helpFor(),
    ).toBeUndefined();
  });

  it('without a number, only flags the chat and turns the AI off', async () => {
    const { sendTo, helpFor, update } = setup({
      humanInterventionPhone: '',
      humanInterventionPauseAi: true,
    });
    expect(await (await helpFor())!.call('Refund')).toBe('sent');
    expect(sendTo).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'thread-1' },
      data: { aiReplyEnabled: false, needsAttention: true },
    });
  });

  it('has nothing to do with no number and the AI left on', async () => {
    expect(
      await setup({ humanInterventionPhone: '' }).helpFor(),
    ).toBeUndefined();
  });

  it('leaves the AI on when the alert could not be sent', async () => {
    const { sendTo, helpFor, update } = setup({
      humanInterventionPauseAi: true,
    });
    sendTo.mockRejectedValueOnce(new Error('offline'));
    await expect((await helpFor())!.call('x')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it('is off without a description, without a phone number, or in a group', async () => {
    expect(
      await setup({ humanInterventionDescription: ' ' }).helpFor(),
    ).toBeUndefined();
    expect(
      await setup({ humanInterventionPhone: 'call me' }).helpFor(),
    ).toBeUndefined();
    expect(
      await setup({}, { peerJid: '1203630@g.us' }).helpFor(),
    ).toBeUndefined();
  });

  it('gives the claim back when the send fails', async () => {
    const { sendTo, helpFor } = setup({});
    sendTo.mockRejectedValueOnce(new Error('not on WhatsApp'));
    await expect((await helpFor())!.call('x')).rejects.toThrow(
      'not on WhatsApp',
    );
    expect(await (await helpFor())!.call('x')).toBe('sent');
  });
});

describe('the red Human needed flag on a conversation', () => {
  it('clears when the AI goes back on or it is cleared by hand, never set by hand', () => {
    expect(parseUpdate({ ai_reply_enabled: true })).toEqual({
      aiReplyEnabled: true,
      needsAttention: false,
    });
    expect(parseUpdate({ ai_reply_enabled: false })).toEqual({
      aiReplyEnabled: false,
    });
    expect(parseUpdate({ needs_attention: false })).toEqual({
      needsAttention: false,
    });
    expect(parseUpdate({ needs_attention: true })).toEqual({});
  });
});
