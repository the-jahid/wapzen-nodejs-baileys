import type { ConfigService } from '@nestjs/config';
import { activity } from '../activity/activity';
import type { AgentFilesService } from '../agent-files/agent-files.service';
import type { Tool } from '../generated/prisma/client';
import type { IndexerService } from '../knowledge-bases/indexer.service';
import type { OrdersService } from '../orders/orders.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ChatToolbox } from '../tools/chat-toolbox';
import {
  ChatResponderService,
  type IncomingChat,
} from './chat-responder.service';
import {
  type ChatOwnerSends,
  createOwnerSendLookup,
  detailsKey,
  type OwnerSend,
  PASSED_ON_MARK,
  phonesIn,
  readDetails,
  SEND_TO_TEAM_FUNCTION,
} from './owner-send';

// Sending what a customer gave to a number the owner named in the prompt: what
// counts as such a number, the send_to_team tool, and what the owner receives.

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../knowledge-bases/indexer.service', () => ({
  IndexerService: class {},
}));
jest.mock('../orders/orders.service', () => ({ OrdersService: class {} }));
jest.mock('../activity/activity');
jest.mock('./reply-language', () => ({ createLanguageGuard: () => ({}) }));
// What the model reads out of the owner's prompt.
const mockRead = jest.fn<unknown, []>(() => []);
jest.mock('./reply-agent', () => ({
  CHAT_REMEMBER_MESSAGES: 40,
  CHAT_SUMMARY_AT: 50,
  isChatSummary: () => false,
  createConfirmationCheck: () => () => Promise.resolve(undefined),
  createReplyAgent: () => ({}),
  chatModel: () => ({
    bindTools: () => ({
      invoke: () => {
        const sends = mockRead();
        return sends instanceof Error
          ? Promise.reject(sends)
          : Promise.resolve({ tool_calls: [{ args: { sends } }] });
      },
    }),
  }),
}));
jest.mock('../chat-conversations/chat-conversations.store', () => ({
  resolvePeerPhones: (_: unknown, rows: unknown[]) => Promise.resolve(rows),
  ensureConversation: jest.fn(() => Promise.resolve('thread-1')),
}));

const AGENT_PHONE = '+8801700000000';
const PATIENT = [
  { label: 'Name', value: 'রহিমা বেগম' },
  { label: 'Age', value: '৪৫' },
];
const when = 'name and age are in';
const what = 'name, age';

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockReturnValue([]);
});

describe('the numbers in the owner’s text', () => {
  it('reads local, international and Bangla digits', () => {
    expect(phonesIn('My WhatsApp 01711-111111.', AGENT_PHONE)).toEqual([
      '+8801711111111',
    ]);
    expect(phonesIn('নাম্বার ০১৭১১১১১১১১ এ', AGENT_PHONE)).toEqual([
      '+8801711111111',
    ]);
    expect(phonesIn('+39 333 123 4567', AGENT_PHONE)).toEqual([
      '+393331234567',
    ]);
    expect(phonesIn('Open 9am-9pm, 250 taka', AGENT_PHONE)).toEqual([]);
  });
});

describe('reading the owner’s prompt', () => {
  const numbers = { agentPhone: AGENT_PHONE };

  it('never asks the model when there is no number to send to', async () => {
    const lookup = createOwnerSendLookup('key');
    expect(await lookup('Be nice. Send it to my WhatsApp.', numbers)).toEqual(
      [],
    );
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('keeps a number only when the owner wrote it, and asks once', async () => {
    mockRead.mockReturnValue([
      { number: '01711-111111', when, what },
      { number: '+8801999999999', when, what },
    ]);
    const lookup = createOwnerSendLookup('key');
    const text = 'Send the name and age to 01711-111111.';
    const expected = [{ key: 'send_1', phone: '+8801711111111', when, what }];
    expect(await lookup(text, numbers)).toEqual(expected);
    expect(await lookup(text, numbers)).toEqual(expected);
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('takes "my WhatsApp" to be the saved number', async () => {
    mockRead.mockReturnValue([{ number: '', when, what }]);
    const lookup = createOwnerSendLookup('key');
    expect(
      await lookup('Send it to my WhatsApp.', {
        ...numbers,
        savedPhone: '+8801822222222',
      }),
    ).toEqual([{ key: 'send_1', phone: '+8801822222222', when, what }]);
  });

  it('asks again after a failed read', async () => {
    mockRead.mockReturnValueOnce(new Error('timeout'));
    const lookup = createOwnerSendLookup('key');
    const text = 'Send it to 01711-111111.';
    await expect(lookup(text, numbers)).rejects.toThrow('timeout');
    mockRead.mockReturnValue([{ number: '01711-111111', when, what }]);
    expect(await lookup(text, numbers)).toHaveLength(1);
  });
});

describe('details', () => {
  it('drops blanks and anything that is not a detail', () => {
    expect(
      readDetails([...PATIENT, { label: 'Address', value: ' ' }, null, 'x']),
    ).toEqual(PATIENT);
    expect(readDetails('name')).toEqual([]);
  });

  it('are the same whatever they are labelled or whichever digits they use', () => {
    expect(detailsKey(PATIENT)).toBe(
      detailsKey([
        { label: 'বয়স', value: '45' },
        { label: 'নাম', value: 'রহিমা বেগম' },
      ]),
    );
  });
});

describe('send_to_team in the toolbox', () => {
  const to: OwnerSend = { key: 'send_1', phone: '+8801711111111', when, what };
  const boxWith = (send: ChatOwnerSends['send']) =>
    ChatToolbox.for(
      [],
      'agent-1',
      () => Promise.resolve(),
      undefined,
      [],
      undefined,
      undefined,
      { list: [to], send },
    )!;

  it('is offered with the owner’s instruction, never with the number', () => {
    const box = boxWith(() => Promise.resolve('sent'));
    expect(box.definitions().map((d) => d.function.name)).toEqual([
      SEND_TO_TEAM_FUNCTION,
    ]);
    expect(box.ownerSendPrompt).toContain(when);
    expect(box.ownerSendPrompt).not.toContain('1711');
  });

  it('sends, and keeps a record the customer never sees', async () => {
    const send = jest.fn(() => Promise.resolve('sent' as const));
    const box = boxWith(send);
    const result = await box.run(SEND_TO_TEAM_FUNCTION, {
      send_id: 'send_1',
      details: PATIENT,
    });
    expect(send).toHaveBeenCalledWith(to, PATIENT, '');
    expect(result).toContain('has been sent');
    expect(box.passedOnRecords).toEqual([
      `${PASSED_ON_MARK} Name: রহিমা বেগম; Age: ৪৫`,
    ]);
    expect(box.withoutFileMarks(`${PASSED_ON_MARK} Name: X\nThank you!`)).toBe(
      'Thank you!',
    );
  });

  it('sends nothing without details or with an id that is not the owner’s', async () => {
    const send = jest.fn(() => Promise.resolve('sent' as const));
    const box = boxWith(send);
    await box.run(SEND_TO_TEAM_FUNCTION, { send_id: 'send_1', details: [] });
    await box.run(SEND_TO_TEAM_FUNCTION, {
      send_id: '+8801999999999',
      details: PATIENT,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('waits for an order confirmed in the same reply to be placed first', async () => {
    const calls: string[] = [];
    const box = ChatToolbox.for(
      [{ id: 't', type: 'order', name: 'Take Order', config: {} } as Tool],
      'agent-1',
      () => Promise.resolve(),
      {
        phoneKnown: true,
        place: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          calls.push('order');
          return { success: true, order_id: 'o', order_number: 1 };
        },
      },
      [],
      undefined,
      undefined,
      {
        list: [to],
        send: () => {
          calls.push('send');
          return Promise.resolve('already');
        },
      },
    )!;
    box.confirmOrder();
    await Promise.all([
      box.run(SEND_TO_TEAM_FUNCTION, { send_id: 'send_1', details: PATIENT }),
      box.run('create_order', {}),
    ]);
    expect(calls).toEqual(['order', 'send']);
  });

  it('never claims a send that failed', async () => {
    const box = boxWith(() => Promise.reject(new Error('offline')));
    expect(
      await box.run(SEND_TO_TEAM_FUNCTION, {
        send_id: 'send_1',
        details: PATIENT,
      }),
    ).toContain('could not be sent');
    expect(box.passedOnRecords).toEqual([]);
  });
});

describe('the responder’s sends', () => {
  function setup(
    agentOverrides: Record<string, unknown> = {},
    chatOverrides: Partial<IncomingChat> = {},
  ) {
    const responder = new ChatResponderService(
      {} as PrismaService,
      { get: () => 'key' } as unknown as ConfigService,
      { enabled: false } as unknown as IndexerService,
      {
        place: () =>
          Promise.resolve({ success: true, order_id: 'o', order_number: 1 }),
        get: () => Promise.resolve({ items: [], custom_fields: [] }),
      } as unknown as OrdersService,
      {} as AgentFilesService,
    );
    const sendTo = jest.fn(() => Promise.resolve());
    const chat: IncomingChat = {
      phoneNumberId: 'number-1',
      peerJid: '8801722222222@s.whatsapp.net',
      peerPhone: '+8801722222222',
      peerName: 'Rahim',
      text: 'House 5',
      send: () => Promise.resolve(),
      sendTo,
      sendFile: () => Promise.resolve(),
      setTyping: () => Promise.resolve(),
      ...chatOverrides,
    };
    const agent = {
      id: 'agent-1',
      userId: 'user-1',
      agentName: 'Shifa',
      systemPrompt: 'Send the name and age to 01711-111111.',
      orderEnabled: false,
      tools: [],
      phoneNumber: { phoneNumber: AGENT_PHONE },
      user: { email: 'owner@example.com' },
      ...agentOverrides,
    };
    const own = responder as unknown as {
      ownerSendsFor(
        key: string,
        a: unknown,
        c: IncomingChat,
      ): Promise<ChatOwnerSends | undefined>;
      alertOwner(a: unknown, c: IncomingChat, result: unknown): void;
    };
    return {
      sendTo,
      sends: () => own.ownerSendsFor('key', agent, chat),
      alert: () =>
        own.alertOwner(agent, chat, {
          success: true,
          order_id: 'o',
          order_number: 1,
        }),
    };
  }

  beforeEach(() =>
    mockRead.mockReturnValue([{ number: '01711-111111', when, what }]),
  );

  it('messages the owner’s number, and the same details only once', async () => {
    const { sendTo, sends } = setup();
    const own = (await sends())!;
    expect(await own.send(own.list[0], PATIENT, '')).toBe('sent');
    expect(sendTo).toHaveBeenCalledWith(
      '+8801711111111',
      [
        '📋 *New information from a customer*\nFrom Shifa',
        '*Name:* রহিমা বেগম\n*Age:* ৪৫',
        '*Customer:* Rahim\n*Phone:* +8801722222222\n*Chat:* https://wa.me/8801722222222',
      ].join('\n\n'),
    );
    expect(activity).toHaveBeenCalledWith(
      "info sent to the owner's number: owner@example.com - Shifa",
    );
    const again = (await sends())!;
    expect(await again.send(again.list[0], PATIENT, '')).toBe('already');
    expect(
      await again.send(again.list[0], [{ label: 'Age', value: '46' }], ''),
    ).toBe('sent');
    expect(sendTo).toHaveBeenCalledTimes(2);
  });

  it('can try again after a failed send', async () => {
    const { sendTo, sends } = setup();
    sendTo.mockRejectedValueOnce(new Error('not on WhatsApp'));
    const own = (await sends())!;
    await expect(own.send(own.list[0], PATIENT, '')).rejects.toThrow();
    expect(await own.send(own.list[0], PATIENT, '')).toBe('sent');
  });

  it('stops one chat from messaging the owner without end', async () => {
    const { sendTo, sends } = setup();
    const own = (await sends())!;
    const age = (n: number) => [{ label: 'Age', value: String(n) }];
    for (let n = 0; n < 10; n++) await own.send(own.list[0], age(n), '');
    await expect(own.send(own.list[0], age(99), '')).rejects.toThrow(
      'too many',
    );
    expect(sendTo).toHaveBeenCalledTimes(10);
  });

  it('does not repeat an order the alert already sent to that number', async () => {
    const { sendTo, sends, alert } = setup({
      orderEnabled: true,
      orderInstructions: 'Send it to my WhatsApp.',
      orderNotifyPhone: '+8801711111111',
      tools: [{ tool: { type: 'order' } }],
    });
    const own = (await sends())!;
    alert();
    expect(await own.send(own.list[0], PATIENT, '')).toBe('already');
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendTo).toHaveBeenCalledTimes(1);
  });

  it('is off in groups, without an instruction, and when the read fails', async () => {
    expect(
      await setup({}, { peerJid: '1203630@g.us' }).sends(),
    ).toBeUndefined();
    mockRead.mockReturnValue([]);
    expect(await setup().sends()).toBeUndefined();
    mockRead.mockReturnValue(new Error('timeout'));
    expect(await setup().sends()).toBeUndefined();
  });
});
