import type { ConfigService } from '@nestjs/config';
import { activity } from '../activity/activity';
import { parseInput, validateUpdate } from '../chat-agents/chat-agents.types';
import type { IndexerService } from '../knowledge-bases/indexer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatOrders } from '../tools/chat-toolbox';
import {
  ChatResponderService,
  type IncomingChat,
} from '../whatsapp/chat-responder.service';
import type { AgentFilesService } from '../agent-files/agent-files.service';
import { orderNotice } from './order-notice';
import type { OrderResult, OrdersService } from './orders.service';
import type { toResource } from './orders.types';

// The owner's order alerts: the message an order turns into, and when the
// agent's number sends it to chat_agents.order_notify_phone.

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../knowledge-bases/indexer.service', () => ({
  IndexerService: class {},
}));
jest.mock('./orders.service', () => ({ OrdersService: class {} }));
jest.mock('../activity/activity');
jest.mock('../whatsapp/reply-agent', () => ({
  CHAT_REMEMBER_MESSAGES: 40,
  CHAT_SUMMARY_AT: 50,
  isChatSummary: () => false,
  createConfirmationCheck: () => () => Promise.resolve(undefined),
  createReplyAgent: () => ({}),
}));
jest.mock('../chat-conversations/chat-conversations.store', () => ({
  resolvePeerPhones: (_: unknown, rows: unknown[]) => Promise.resolve(rows),
}));

type OrderResource = ReturnType<typeof toResource>;

const ORDER: OrderResource = {
  id: 'order-1',
  order_number: 1003,
  customer_name: 'Rahim',
  phone: '+8801722222222',
  email: null,
  description: 'Lunch for the office',
  items: [
    { name: 'Chicken burger', quantity: 2, note: 'no onions' },
    { name: 'Cola' },
  ],
  delivery_address: 'House 12, Road 5, Dhanmondi',
  custom_fields: [
    { key: 'delivery_time', label: 'Delivery time', value: '1 pm' },
  ],
  status: 'new',
  channel: 'chat',
  internal_note: null,
  agent_id: 'agent-1',
  agent_name: 'Dhaka Bites',
  conversation_id: 'thread',
  created_at: '2026-11-13T06:00:00.000Z',
  updated_at: '2026-11-13T06:00:00.000Z',
};

describe('orderNotice', () => {
  it('sets out a new order with everything it holds, and no blank lines for what it lacks', () => {
    expect(orderNotice(ORDER, { updated: false, agentName: 'Dhaka Bites' }))
      .toBe(`🛒 *New order #1003*
Taken by Dhaka Bites

*Customer:* Rahim
*Phone:* +8801722222222
*Delivery address:* House 12, Road 5, Dhanmondi

*Items*
• 2 × Chicken burger (no onions)
• Cola

*Order:* Lunch for the office

*Delivery time:* 1 pm`);
  });

  it('says when an order was changed rather than placed', () => {
    const text = orderNotice(
      { ...ORDER, items: [], description: '', custom_fields: [] },
      { updated: true, agentName: 'Dhaka Bites' },
    );
    expect(text.split('\n')[0]).toBe('✏️ *Order #1003 changed*');
    expect(text).not.toContain('*Items*');
    expect(text).not.toContain('*Order:*');
  });

  it('keeps a runaway order to a readable length', () => {
    const text = orderNotice(
      { ...ORDER, description: 'x'.repeat(10_000) },
      { updated: false, agentName: '' },
    );
    expect(text.length).toBe(3000);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('order_notify_phone on the API', () => {
  it('is accepted in the order section and counts as a change', () => {
    const input = parseInput({
      order: { order_notify_phone: '+8801711111111' },
    });
    expect(input.order).toEqual({ order_notify_phone: '+8801711111111' });
    expect(() => validateUpdate(input)).not.toThrow();
  });

  it('refuses one longer than a phone number could be', () => {
    expect(() =>
      validateUpdate({ order: { order_notify_phone: '1'.repeat(41) } }),
    ).toThrow();
    expect(() => parseInput({ order: { order_notify_phone: 1 } })).toThrow();
  });
});

describe('alerting the owner', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function setup(notifyPhone: string, result: OrderResult) {
    const orders = {
      place: jest.fn(() => Promise.resolve(result)),
      get: jest.fn(() => Promise.resolve(ORDER)),
    };
    const responder = new ChatResponderService(
      {} as PrismaService,
      { get: () => 'key' } as unknown as ConfigService,
      { enabled: false } as unknown as IndexerService,
      orders as unknown as OrdersService,
      {} as AgentFilesService,
    );
    const sendTo = jest.fn(() => Promise.resolve());
    const send = jest.fn(() => Promise.resolve());
    const chat: IncomingChat = {
      phoneNumberId: 'number-1',
      peerJid: '8801722222222@s.whatsapp.net',
      peerPhone: '+8801722222222',
      text: 'yes',
      send,
      sendTo,
      sendFile: () => Promise.resolve(),
      setTyping: () => Promise.resolve(),
    };
    const agent = {
      id: 'agent-1',
      userId: 'user-1',
      agentName: 'Dhaka Bites',
      orderEnabled: true,
      orderNotifyPhone: notifyPhone,
      phoneNumber: { phoneNumber: '+8801700000000' },
      user: { email: 'owner@example.com' },
    };
    const place = async () => {
      const box = await (
        responder as unknown as {
          ordersFor(a: unknown, c: IncomingChat): Promise<ChatOrders>;
        }
      ).ordersFor(agent, chat);
      const placed = await box.place({}, []);
      await flush();
      return placed;
    };
    return { orders, sendTo, send, place };
  }

  const PLACED: OrderResult = {
    success: true,
    order_id: 'order-1',
    order_number: 1003,
  };

  beforeEach(() => jest.clearAllMocks());

  it('messages the owner’s number from the agent’s number when an order is placed', async () => {
    const { sendTo, send, place } = setup('+880 1711-111111', PLACED);
    expect(await place()).toEqual(PLACED);
    expect(sendTo).toHaveBeenCalledTimes(1);
    expect(sendTo).toHaveBeenCalledWith(
      '+8801711111111',
      expect.stringContaining('🛒 *New order #1003*'),
    );
    // The customer's chat gets nothing extra.
    expect(send).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledWith(
      'order alert sent: owner@example.com - #1003 by Dhaka Bites',
    );
  });

  it('takes a local number in the country of the agent’s number', async () => {
    const { sendTo, place } = setup('01711-111111', PLACED);
    await place();
    expect(sendTo).toHaveBeenCalledWith('+8801711111111', expect.any(String));
  });

  it('says an order was changed when the chat’s open order was updated', async () => {
    const { sendTo, place } = setup('+8801711111111', {
      ...PLACED,
      updated: true,
    });
    await place();
    expect(sendTo).toHaveBeenCalledWith(
      '+8801711111111',
      expect.stringContaining('✏️ *Order #1003 changed*'),
    );
  });

  it('sends nothing with no number, for an order already there, or one that failed', async () => {
    for (const [phone, result] of [
      ['', PLACED],
      ['   ', PLACED],
      ['+8801711111111', { ...PLACED, already_placed: true }],
      ['+8801711111111', { success: false, error: 'no' }],
    ] as [string, OrderResult][]) {
      const { sendTo, orders, place } = setup(phone, result);
      await place();
      expect(sendTo).not.toHaveBeenCalled();
      expect(orders.get).not.toHaveBeenCalled();
    }
  });

  it('skips, and logs, a number that isn’t a phone number', async () => {
    const { sendTo, place } = setup('call the shop', PLACED);
    await place();
    expect(sendTo).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledWith(
      'order alert skipped (not a phone number): owner@example.com - #1003 by Dhaka Bites',
    );
  });

  it('places the order even when the alert can’t be sent', async () => {
    const { sendTo, place } = setup('+8801711111111', PLACED);
    sendTo.mockImplementationOnce(() =>
      Promise.reject(new Error('+8801711111111 is not on WhatsApp')),
    );
    expect(await place()).toEqual(PLACED);
    expect(activity).toHaveBeenCalledWith(
      'order alert failed: owner@example.com - #1003 by Dhaka Bites: +8801711111111 is not on WhatsApp',
    );
  });
});
