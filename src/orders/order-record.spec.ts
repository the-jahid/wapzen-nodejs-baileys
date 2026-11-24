import type { Tool } from '../generated/prisma/client';
import { ChatToolbox } from '../tools/chat-toolbox';
import {
  ORDER_FUNCTION,
  ORDER_MARK,
  orderRecord,
  withoutOrderRecords,
} from './order-tool';
import type { OrderResult } from './orders.service';

// The line that keeps a placed order in the agent's history, so a later reply
// doesn't take it back.

jest.mock('./orders.service', () => ({ OrdersService: class {} }));
jest.mock('../whatsapp/reply-agent', () => ({}));

const TAKE_ORDER = {
  id: 't',
  type: 'order',
  name: 'Take Order',
  config: {},
} as Tool;

const boxThat = (result: OrderResult) =>
  ChatToolbox.for([TAKE_ORDER], 'agent-1', () => Promise.resolve(), {
    phoneKnown: true,
    place: () => Promise.resolve(result),
  })!;

const PLACED: OrderResult = {
  success: true,
  order_id: 'o',
  order_number: 1001,
};

describe('the order record', () => {
  it('says what a placed order holds, on one line', async () => {
    const box = boxThat(PLACED);
    box.confirmOrder();
    await box.run(ORDER_FUNCTION, { description: '1 cheese\nburger' });
    expect(box.doneRecords).toEqual([
      `${ORDER_MARK} #1001, confirmed and placed, now: 1 cheese burger`,
    ]);
  });

  it('says when an order was changed', async () => {
    const box = boxThat({ ...PLACED, updated: true });
    box.confirmOrder();
    await box.run(ORDER_FUNCTION, { description: '2 cheese burgers' });
    expect(box.doneRecords).toEqual([
      `${ORDER_MARK} #1001, change confirmed and saved, now: 2 cheese burgers`,
    ]);
  });

  it('is kept only for an order that was placed', async () => {
    const unconfirmed = boxThat(PLACED);
    await unconfirmed.run(ORDER_FUNCTION, { description: 'x' });
    expect(unconfirmed.doneRecords).toEqual([]);

    const failed = boxThat({ success: false, error: 'no' });
    failed.confirmOrder();
    await failed.run(ORDER_FUNCTION, { description: 'x' });
    expect(failed.doneRecords).toEqual([]);
  });

  it('is explained only to an agent that takes orders', () => {
    expect(boxThat(PLACED).orderRecordPrompt).toContain(ORDER_MARK);
    const other = ChatToolbox.for(
      [{ ...TAKE_ORDER, type: 'send_text', name: 'send_link' }],
      'agent-1',
      () => Promise.resolve(),
    )!;
    expect(other.orderRecordPrompt).toBe('');
  });

  it('never reaches the customer or the confirmation check', () => {
    const line = orderRecord(1001);
    expect(boxThat(PLACED).withoutFileMarks(`${line}\nThank you!`)).toBe(
      'Thank you!',
    );
    expect(withoutOrderRecords(`${line}\nShall I place it?`)).toBe(
      'Shall I place it?',
    );
  });
});
