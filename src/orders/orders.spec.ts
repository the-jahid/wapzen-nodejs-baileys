import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { HttpException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ChatAgentsService } from '../chat-agents/chat-agents.service';
import { PrismaClient } from '../generated/prisma/client';
import { ToolsController } from '../tools/tools.controller';
import { ChatToolbox } from '../tools/chat-toolbox';
import { ToolsService } from '../tools/tools.service';
import {
  parseOrderFields,
  toResource as toolResource,
} from '../tools/tools.types';
import {
  DEFAULT_ORDER_FIELDS,
  ORDER_FUNCTION,
  orderParameters,
  orderPrompt,
  requiredDetails,
} from './order-tool';
import { OrdersService, type OrderContext } from './orders.service';
import {
  cleanText,
  ordersCsv,
  parseOrderArgs,
  parseUpdate,
  toE164,
  toResource,
} from './orders.types';
import type { PrismaService } from '../prisma/prisma.service';

// Runs against a real Postgres (PGlite, in this process) with the project's own
// migrations, because what matters here lives in the database: the seed and
// the trigger, the row lock behind duplicate prevention, and every scoped query.

// Nothing here reads config, and the package is ESM-only, which Jest can't load.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../activity/activity');
jest.setTimeout(60_000);

const PORT = 55433;
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

let pg: PGlite;
let server: PGLiteSocketServer;
let prisma: PrismaClient;
let orders: OrdersService;
let tools: ToolsService;

async function migrate(until?: string, from = '') {
  const names = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    if (until && name >= until) break;
    if (name < from) continue;
    await pg.exec(
      readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'),
    );
  }
  return names;
}

const argsFor = (overrides: Record<string, unknown> = {}) => ({
  customer_name: 'Ayesha Rahman',
  phone: '+8801712345678',
  description: '2 large margherita pizzas, deliver to Banani',
  ...overrides,
});

let peer = 0;
function contextFor(
  userId: string,
  agentId: string,
  phoneNumberId: string,
  overrides: Partial<OrderContext> = {},
): OrderContext {
  peer += 1;
  return {
    userId,
    ownerEmail: 'owner@example.com',
    agentId,
    agentName: 'Sales',
    phoneNumberId,
    peerJid: `88017000000${peer}@s.whatsapp.net`,
    customerPhone: '+8801700000001',
    ...overrides,
  };
}

async function newAccount(label: string) {
  const user = await prisma.user.create({
    data: { email: `${label}@example.com`, oauthId: `user_${label}` },
  });
  const phone = await prisma.phoneNumber.create({
    data: {
      userId: user.id,
      phoneNumber: `+88017${label.length}${peer++}0000`.slice(0, 14),
    },
  });
  const agent = await prisma.chatAgent.create({
    data: {
      userId: user.id,
      agentName: `${label} agent`,
      phoneNumberId: phone.id,
    },
  });
  return { user, phone, agent };
}

beforeAll(async () => {
  pg = await PGlite.create();
  // Everything up to, but not including, this feature's migration: the seed
  // has to find accounts that already exist.
  await migrate('20261031000003');
  await pg.exec(
    `INSERT INTO users (id, email, oauth_id) VALUES ('existing', 'old@example.com', 'user_old')`,
  );
  await pg.exec(
    readFileSync(
      join(MIGRATIONS, '20261031000003_orders', 'migration.sql'),
      'utf8',
    ),
  );
  await migrate(undefined, '20261031000004');

  server = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1' });
  await server.start();
  prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`,
      max: 1,
    }),
  });
  orders = new OrdersService(prisma as unknown as PrismaService);
  tools = new ToolsService(prisma as unknown as PrismaService);
});

afterAll(async () => {
  await prisma?.$disconnect();
  await server?.stop();
  await pg?.close();
});

describe('tool seeding', () => {
  it('gives accounts that already existed the tool', async () => {
    const seeded = await prisma.tool.findMany({
      where: { userId: 'existing' },
    });
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({
      name: 'Take Order',
      key: 'take_order',
      type: 'order',
      isSystem: true,
    });
  });

  it('gives a new account the tool however its row was created', async () => {
    const { user } = await newAccount('newbie');
    await prisma.$executeRaw`
      INSERT INTO users (email, oauth_id) VALUES ('raw@example.com', 'user_raw')`;
    const raw = await prisma.user.findUniqueOrThrow({
      where: { oauthId: 'user_raw' },
    });
    for (const id of [user.id, raw.id]) {
      expect(
        await prisma.tool.count({ where: { userId: id, key: 'take_order' } }),
      ).toBe(1);
    }
  });

  it('lists the tool first and marks it as built in', async () => {
    const { user } = await newAccount('lister');
    await tools.create(user.id, {
      type: 'send_text',
      name: 'send_link',
      description: 'Sends a link.',
    });
    const { tools: listed } = await tools.list(user.id, '', 1, 50);
    expect(listed[0]).toMatchObject({
      name: 'Take Order',
      key: 'take_order',
      type: 'order',
      is_system: true,
    });
    expect(listed[1]).toMatchObject({ name: 'send_link', is_system: false });
  });

  it("won't let the tool be deleted or edited", async () => {
    const { user } = await newAccount('editor');
    const tool = await prisma.tool.findFirstOrThrow({
      where: { userId: user.id, key: 'take_order' },
    });

    await expect(tools.remove(user.id, tool.id)).rejects.toMatchObject({
      status: 403,
    });

    const controller = new ToolsController(tools);
    await expect(
      controller.update(user as never, tool.id, { name: 'renamed' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      controller.update(user as never, tool.id, { description: 'changed' }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      prisma.tool.findUniqueOrThrow({ where: { id: tool.id } }),
    ).resolves.toMatchObject({ name: 'Take Order' });
  });

  it('refuses creating an order tool or taking its function name', async () => {
    const { user } = await newAccount('creator');
    const controller = new ToolsController(tools);
    await expect(
      controller.create(user as never, {
        type: 'order',
        name: 'mine',
        description: 'x',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      controller.create(user as never, {
        type: 'send_text',
        name: ORDER_FUNCTION,
        description: 'x',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('create_order', () => {
  it('places an order and numbers them per account', async () => {
    const a = await newAccount('alpha');
    const b = await newAccount('bravo');
    const context = contextFor(a.user.id, a.agent.id, a.phone.id);

    const first = await orders.place(context, argsFor());
    const second = await orders.place(
      context,
      argsFor({ description: 'one garlic bread' }),
    );
    const other = await orders.place(
      contextFor(b.user.id, b.agent.id, b.phone.id),
      argsFor(),
    );

    expect(first).toMatchObject({ success: true, order_number: 1001 });
    expect(second).toMatchObject({ success: true, order_number: 1002 });
    expect(other).toMatchObject({ success: true, order_number: 1001 });

    const row = await prisma.order.findFirstOrThrow({
      where: { userId: a.user.id, orderNumber: 1001 },
    });
    expect(row).toMatchObject({
      agentId: a.agent.id,
      customerName: 'Ayesha Rahman',
      phone: '+8801712345678',
      status: 'new',
      channel: 'chat',
    });
    expect(row.conversationId).toBeTruthy();
    const thread = await prisma.chatConversation.findUniqueOrThrow({
      where: { id: row.conversationId! },
    });
    expect(thread).toMatchObject({
      userId: a.user.id,
      peerJid: context.peerJid,
    });
  });

  it("uses the sender's number when the customer gave none", async () => {
    const a = await newAccount('prefill');
    const placed = await orders.place(
      contextFor(a.user.id, a.agent.id, a.phone.id, {
        customerPhone: '+8801799999999',
      }),
      argsFor({ phone: undefined }),
    );
    expect(placed.success).toBe(true);
    const row = await prisma.order.findFirstOrThrow({
      where: { userId: a.user.id },
    });
    expect(row.phone).toBe('+8801799999999');
  });

  it('never reuses the number of a deleted order', async () => {
    const a = await newAccount('deleted');
    const context = contextFor(a.user.id, a.agent.id, a.phone.id);
    const first = await orders.place(context, argsFor());
    if (!first.success) throw new Error(first.error);
    await orders.remove(a.user.id, first.order_id);
    const next = await orders.place(context, argsFor());
    expect(next).toMatchObject({ order_number: 1002 });
  });
});

describe('validation', () => {
  const context = { customerPhone: '+8801700000000' };

  it('names every missing or invalid field', () => {
    const { order, errors } = parseOrderArgs(
      { email: 'not-an-email', phone: '12' },
      { customerPhone: null },
    );
    expect(order).toBeUndefined();
    expect(errors.map((e) => e.field)).toEqual([
      'customer_name',
      'phone',
      'email',
      'description',
    ]);
  });

  it('tells the agent what to ask for instead of throwing', async () => {
    const a = await newAccount('invalid');
    const result = await orders.place(
      contextFor(a.user.id, a.agent.id, a.phone.id, {
        customerPhone: undefined,
      }),
      { customer_name: 'Sam', description: 'one pizza' },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('phone number');
    expect(await prisma.order.count({ where: { userId: a.user.id } })).toBe(0);
  });

  it('checks items', () => {
    const { errors } = parseOrderArgs(
      argsFor({ items: [{ name: 'Pizza', quantity: -1 }, { quantity: 2 }] }),
      context,
    );
    expect(errors.map((e) => e.field)).toEqual([
      'items[0].quantity',
      'items[1].name',
    ]);
  });

  it('drops the placeholders a model writes for an optional field', () => {
    const { order } = parseOrderArgs(
      argsFor({ email: 'N/A', delivery_address: 'none' }),
      context,
    );
    expect(order).toMatchObject({ email: null, deliveryAddress: null });
  });

  it('sanitizes what the customer typed', () => {
    expect(cleanText('  <script>alert(1)</script>Two\u0000 pizzas\n ')).toBe(
      'alert(1)Two pizzas',
    );
    expect(cleanText('size < 5 and > 3')).toBe('size < 5 and > 3');
  });

  it.each([
    ['+8801712345678', undefined, '+8801712345678'],
    ['+880 1712-345678', undefined, '+8801712345678'],
    ['008801712345678', undefined, '+8801712345678'],
    ['01712345678', '+8801700000000', '+8801712345678'],
    ['1712345678', '+8801700000000', '+8801712345678'],
    ['8801712345678', '+8801700000000', '+8801712345678'],
    ['(202) 555-0123', '+14155550100', '+12025550123'],
    ['3931234567', '+393331234567', '+393931234567'],
    ['01712345678', undefined, null],
    ['12', '+8801700000000', null],
    ['+0123456789', undefined, null],
    ['call me', '+8801700000000', null],
  ])('turns %s into E.164', (raw, reference, expected) => {
    expect(toE164(raw, reference)).toBe(expected);
  });

  it('takes only a known status and the note on PATCH', () => {
    expect(parseUpdate({ status: 'confirmed' })).toEqual({
      status: 'confirmed',
    });
    expect(parseUpdate({ internal_note: '<b>Paid</b> ' })).toEqual({
      internalNote: 'Paid',
    });
    expect(() => parseUpdate({ status: 'shipped' })).toThrow();
    expect(() => parseUpdate({ customer_name: 'x' })).toThrow();
    expect(() => parseUpdate({})).toThrow();
  });
});

describe('duplicate prevention', () => {
  it('returns the existing order for an identical one', async () => {
    const a = await newAccount('dupe');
    const context = contextFor(a.user.id, a.agent.id, a.phone.id);
    const first = await orders.place(context, argsFor());
    const again = await orders.place(
      context,
      argsFor({
        description: '2 LARGE margherita   pizzas, deliver to Banani',
      }),
    );
    expect(again).toEqual(first);
    expect(await prisma.order.count({ where: { userId: a.user.id } })).toBe(1);
  });

  it('sees through a reworded description of the same items', async () => {
    const a = await newAccount('reworded');
    const context = contextFor(a.user.id, a.agent.id, a.phone.id);
    const items = [{ name: 'Pepperoni', quantity: 1 }];
    const first = await orders.place(context, argsFor({ items }));
    const again = await orders.place(
      context,
      argsFor({ description: 'One large pepperoni pizza', items }),
    );
    expect(again).toEqual(first);
  });

  it('keeps one order when two identical calls race', async () => {
    const a = await newAccount('race');
    const context = contextFor(a.user.id, a.agent.id, a.phone.id);
    const [one, two] = await Promise.all([
      orders.place(context, argsFor()),
      orders.place(context, argsFor()),
    ]);
    expect(one).toEqual(two);
    expect(await prisma.order.count({ where: { userId: a.user.id } })).toBe(1);
  });

  it('treats a different order, another chat or an old order as new', async () => {
    const a = await newAccount('distinct');
    const context = contextFor(a.user.id, a.agent.id, a.phone.id);
    const first = await orders.place(context, argsFor());
    if (!first.success) throw new Error(first.error);

    const different = await orders.place(
      context,
      argsFor({ description: 'one garlic bread' }),
    );
    const otherChat = await orders.place(
      contextFor(a.user.id, a.agent.id, a.phone.id),
      argsFor(),
    );
    await prisma.order.update({
      where: { id: first.order_id },
      data: { createdAt: new Date(Date.now() - 3 * 60_000) },
    });
    const later = await orders.place(context, argsFor());

    expect(different).toMatchObject({ order_number: 1002 });
    expect(otherChat).toMatchObject({ order_number: 1003 });
    expect(later).toMatchObject({ order_number: 1004 });
  });

  it('lets a cancelled order be placed again', async () => {
    const a = await newAccount('cancelled');
    const context = contextFor(a.user.id, a.agent.id, a.phone.id);
    const first = await orders.place(context, argsFor());
    if (!first.success) throw new Error(first.error);
    await orders.update(a.user.id, first.order_id, { status: 'cancelled' });
    const again = await orders.place(context, argsFor());
    expect(again).toMatchObject({ order_number: 1002 });
  });
});

describe('order_enabled', () => {
  const send = () => Promise.resolve();
  const place = jest.fn(() =>
    Promise.resolve({
      success: true as const,
      order_id: 'id',
      order_number: 1024,
    }),
  );

  async function takeOrderRow(label: string) {
    const { user } = await newAccount(label);
    return prisma.tool.findFirstOrThrow({
      where: { userId: user.id, key: 'take_order' },
    });
  }

  it('offers no create_order when ordering is off', async () => {
    const tool = await takeOrderRow('toggleoff');
    expect(ChatToolbox.for([tool], 'agent', send)).toBeNull();

    const other = {
      ...tool,
      id: 'other',
      type: 'send_text',
      name: 'send_link',
      description: 'Sends a link.',
      isSystem: false,
      key: null,
    };
    const box = ChatToolbox.for([tool, other], 'agent', send)!;
    expect(box.takesOrders).toBe(false);
    expect(box.definitions().map((d) => d.function.name)).toEqual([
      'send_link',
    ]);
    expect(await box.run(ORDER_FUNCTION, argsFor())).toContain('Unknown tool');
    expect(place).not.toHaveBeenCalled();
  });

  it('offers no create_order unless the tool is attached', () => {
    const box = ChatToolbox.for([], 'agent', send, { phoneKnown: true, place });
    expect(box).toBeNull();
  });

  it('offers and runs create_order when both are on', async () => {
    const tool = await takeOrderRow('toggleon');
    const box = ChatToolbox.for([tool], 'agent', send, {
      phoneKnown: true,
      place,
    })!;
    expect(box.takesOrders).toBe(true);
    const [definition] = box.definitions();
    expect(definition.function.name).toBe(ORDER_FUNCTION);
    expect(definition.function.parameters).toEqual(orderParameters(true));

    box.confirmOrder();
    const result = await box.run(ORDER_FUNCTION, argsFor());
    expect(JSON.parse(result)).toEqual({
      success: true,
      order_id: 'id',
      order_number: 1024,
    });
  });

  it('refuses an order the customer has not confirmed', async () => {
    const tool = await takeOrderRow('unconfirmed');
    const placeNever = jest.fn();
    const box = ChatToolbox.for([tool], 'agent', send, {
      phoneKnown: true,
      place: placeNever,
    })!;

    const result = await box.run(ORDER_FUNCTION, argsFor());

    expect(result).toContain('"success":false');
    expect(result).toContain('not confirmed');
    expect(placeNever).not.toHaveBeenCalled();
    expect(await box.placedOrderNumber()).toBeUndefined();
  });

  it('places one order per reply, but lets a failed call be retried', async () => {
    const tool = await takeOrderRow('onereply');
    const placeOnce = jest
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'name missing' })
      .mockResolvedValue({ success: true, order_id: 'id', order_number: 7 });
    const box = ChatToolbox.for([tool], 'agent', send, {
      phoneKnown: true,
      place: placeOnce,
    })!;
    box.confirmOrder();

    expect(await box.placedOrderNumber()).toBeUndefined();
    await box.run(ORDER_FUNCTION, argsFor());
    expect(await box.placedOrderNumber()).toBeUndefined();

    const [one, two] = await Promise.all([
      box.run(ORDER_FUNCTION, argsFor()),
      box.run(ORDER_FUNCTION, argsFor({ description: 'said differently' })),
    ]);
    expect(one).toBe(two);
    expect(placeOnce).toHaveBeenCalledTimes(2);
    expect(await box.placedOrderNumber()).toBe(7);
  });

  it('requires a phone from the model only when the sender has none', () => {
    expect(orderParameters(true).required).not.toContain('phone');
    expect(orderParameters(false).required).toContain('phone');
  });

  it('takes the name from an older tool of the owner', async () => {
    const tool = await takeOrderRow('collision');
    const older = {
      ...tool,
      id: 'older',
      type: 'send_text',
      name: ORDER_FUNCTION,
      description: 'Theirs.',
      isSystem: false,
      key: null,
    };
    const orderOn = { phoneKnown: true, place };
    for (const rows of [
      [older, tool],
      [tool, older],
    ]) {
      const box = ChatToolbox.for(rows, 'agent', send, orderOn)!;
      expect(box.definitions()).toHaveLength(1);
      expect(box.takesOrders).toBe(true);
    }
    expect(ChatToolbox.for([older, tool], 'agent', send)!.takesOrders).toBe(
      false,
    );
  });

  it('reports orders_on only with the toggle on and the tool attached', async () => {
    const agents = new ChatAgentsService(prisma as unknown as PrismaService);
    const { user, agent } = await newAccount('agentapi');
    const tool = await prisma.tool.findFirstOrThrow({
      where: { userId: user.id, key: 'take_order' },
    });

    const untouched = await agents.get(user.id, agent.id);
    expect(untouched.order).toEqual({
      order_enabled: false,
      order_instructions: '',
      orders_on: false,
    });

    const toggled = await agents.update(user.id, agent.id, {
      order: {
        order_enabled: true,
        order_instructions: ' Dhaka only <b>x</b> ',
      },
    });
    expect(toggled.order).toEqual({
      order_enabled: true,
      order_instructions: 'Dhaka only x',
      orders_on: false,
    });

    const attached = await agents.update(user.id, agent.id, {
      tools: { tool_ids: [tool.id] },
    });
    expect(attached.order.orders_on).toBe(true);
    expect(attached.tools.tool_ids).toEqual([tool.id]);
  });
});

describe('workspace isolation', () => {
  let owner: Awaited<ReturnType<typeof newAccount>>;
  let stranger: Awaited<ReturnType<typeof newAccount>>;
  let orderId: string;

  beforeAll(async () => {
    owner = await newAccount('owner');
    stranger = await newAccount('stranger');
    const placed = await orders.place(
      contextFor(owner.user.id, owner.agent.id, owner.phone.id),
      argsFor(),
    );
    if (!placed.success) throw new Error(placed.error);
    orderId = placed.order_id;
    await orders.place(
      contextFor(stranger.user.id, stranger.agent.id, stranger.phone.id),
      argsFor({ customer_name: 'Someone Else' }),
    );
  });

  it('lists only the account’s own orders, with a new-order count', async () => {
    const mine = await orders.list(owner.user.id, {}, 1, 50);
    expect(mine.total).toBe(1);
    expect(mine.newOrders).toBe(1);
    expect(mine.orders[0].agent_name).toBe('owner agent');
  });

  it('finds nothing with a filter or search over someone else’s data', async () => {
    const byAgent = await orders.list(
      owner.user.id,
      { agentId: stranger.agent.id },
      1,
      50,
    );
    expect(byAgent.total).toBe(0);
    const bySearch = await orders.list(
      owner.user.id,
      { search: 'Someone Else' },
      1,
      50,
    );
    expect(bySearch.total).toBe(0);
  });

  it('treats someone else’s order as missing everywhere', async () => {
    const id = orderId;
    const user = stranger.user.id;
    await expect(orders.get(user, id)).rejects.toMatchObject({ status: 404 });
    await expect(
      orders.update(user, id, { status: 'cancelled' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(orders.remove(user, id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await orders.exportCsv(user, {})).not.toContain('Ayesha');
    expect(await prisma.order.findUnique({ where: { id } })).toMatchObject({
      status: 'new',
    });
  });
});

describe('list and export', () => {
  let account: Awaited<ReturnType<typeof newAccount>>;

  beforeAll(async () => {
    account = await newAccount('filters');
    const context = contextFor(
      account.user.id,
      account.agent.id,
      account.phone.id,
    );
    await orders.place(
      context,
      argsFor({ customer_name: 'Bilal', email: 'B@Example.com' }),
    );
    await orders.place(
      context,
      argsFor({ customer_name: 'Chandni', phone: '+8801811111111' }),
    );
    const third = await orders.place(
      context,
      argsFor({ customer_name: 'Dipa' }),
    );
    if (!third.success) throw new Error(third.error);
    await orders.update(account.user.id, third.order_id, {
      status: 'completed',
    });
  });

  const search = async (term: string) =>
    (await orders.list(account.user.id, { search: term }, 1, 50)).orders.map(
      (o) => o.customer_name,
    );

  it('searches name, phone, email and order number', async () => {
    expect(await search('chand')).toEqual(['Chandni']);
    expect(await search('01811')).toEqual(['Chandni']);
    expect(await search('b@example')).toEqual(['Bilal']);
    expect(await search('#1001')).toEqual(['Bilal']);
  });

  it('filters by status and date range, and pages', async () => {
    const user = account.user.id;
    const completed = await orders.list(user, { status: 'completed' }, 1, 50);
    expect(completed.orders.map((o) => o.customer_name)).toEqual(['Dipa']);
    expect(completed.newOrders).toBe(2);

    const future = new Date(Date.now() + 60_000);
    expect((await orders.list(user, { from: future }, 1, 50)).total).toBe(0);
    expect((await orders.list(user, { to: future }, 1, 50)).total).toBe(3);

    const paged = await orders.list(user, {}, 2, 2);
    expect(paged.total).toBe(3);
    expect(paged.orders).toHaveLength(1);
  });

  it('exports what the filter selects', async () => {
    const csv = await orders.exportCsv(account.user.id, {
      status: 'completed',
    });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Dipa"');
  });

  it('keeps a customer from writing a formula into the export', () => {
    const row = {
      id: 'x',
      userId: 'u',
      agentId: null,
      conversationId: null,
      orderNumber: 1,
      customerName: '=HYPERLINK("http://evil","click")',
      phone: '+8801712345678',
      email: null,
      description: '@SUM(1)',
      items: [],
      deliveryAddress: null,
      customFields: [{ key: 'note', label: 'Note', value: '=1+1' }],
      status: 'new',
      channel: 'chat',
      internalNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      agent: null,
    };
    const csv = ordersCsv([toResource(row)]);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(csv).toContain(`"'@SUM(1)"`);
    expect(csv).toContain('"+8801712345678"');
    expect(csv).toContain('"Note: =1+1"');
  });
});

describe('order fields', () => {
  const table = { key: 'table_number', label: 'Table number', required: true };
  const notes = { key: 'notes', label: 'Notes', required: false };
  const name = { key: 'customer_name', label: 'Name', required: false };

  it('offers the model exactly the owner fields', () => {
    const parameters = orderParameters(true, [table, notes]);
    expect(Object.keys(parameters.properties)).toEqual([
      'table_number',
      'notes',
    ]);
    expect(parameters.required).toEqual(['table_number']);
  });

  it('asks for what is required and offers what the owner added', () => {
    const prompt = orderPrompt('', true, [table, notes]);
    expect(prompt).toContain(
      'one at a time: Table number, anything the instructions',
    );
    expect(prompt).toContain('Also ask once for: Notes.');
    expect(prompt).not.toContain('the name');
    expect(prompt).not.toContain('what they want');
  });

  it('keeps the prompt for an account that changed nothing', () => {
    expect(requiredDetails(DEFAULT_ORDER_FIELDS)).toEqual([
      'the name',
      'what they want',
    ]);
  });

  it('places an order without the fields the owner deleted', () => {
    const { order, errors } = parseOrderArgs(
      { customer_name: 'ignored', email: 'a@b.co', table_number: '7' },
      { customerPhone: '+8801700000000', peerName: 'Sam' },
      [table, notes],
    );
    expect(errors).toEqual([]);
    expect(order).toMatchObject({
      customerName: 'Sam',
      phone: '+8801700000000',
      email: null,
      description: '',
      customFields: [
        { key: 'table_number', label: 'Table number', value: '7' },
      ],
    });
  });

  it('holds a required field the owner added', () => {
    const { errors } = parseOrderArgs(
      { notes: 'none' },
      { customerPhone: '+8801700000000' },
      [table, notes],
    );
    expect(errors).toEqual([
      { field: 'table_number', message: 'ask for Table number' },
    ]);
  });

  it('refuses an order with nothing in it', () => {
    const { order, errors } = parseOrderArgs(
      {},
      { customerPhone: '+8801700000000' },
      [name],
    );
    expect(order).toBeUndefined();
    expect(errors[0].field).toBe('order');
  });

  it('gives a new field a key, and brings a deleted one back by name', () => {
    const fields = parseOrderFields({
      fields: [
        { key: 'customer_name', label: 'Customer name', required: true },
        { label: 'Table  number', required: true },
        { label: 'Delivery address' },
        { label: 'টেবিল' },
        { label: 'নোট' },
      ],
    });
    expect(fields.map((f) => f.key)).toEqual([
      'customer_name',
      'table_number',
      'delivery_address',
      'field_2',
      'field_3',
    ]);
    expect(fields[1].label).toBe('Table number');
  });

  it('refuses an empty list, a blank name and a repeated name', () => {
    const errorsOf = (fields: unknown[]) => {
      try {
        parseOrderFields({ fields });
        return [];
      } catch (err) {
        const body = (err as HttpException).getResponse() as {
          errors: { field: string }[];
        };
        return body.errors.map((e) => e.field);
      }
    };
    expect(errorsOf([])).toEqual(['fields']);
    expect(errorsOf([{ label: ' ' }])).toEqual(['fields[0].label']);
    expect(errorsOf([{ label: 'Size' }, { label: 'size' }])).toEqual([
      'fields[1].label',
    ]);
  });

  it('stores the list per account and uses it when placing', async () => {
    const a = await newAccount('fields');
    const tool = await prisma.tool.findFirstOrThrow({
      where: { userId: a.user.id, type: 'order' },
    });
    expect(toolResource(tool).order?.fields).toEqual(DEFAULT_ORDER_FIELDS);

    const saved = await tools.setOrderFields(a.user.id, tool.id, [table]);
    expect(saved.order?.fields).toEqual([table]);

    const result = await orders.place(
      contextFor(a.user.id, a.agent.id, a.phone.id),
      { table_number: '7' },
      [table],
    );
    expect(result.success).toBe(true);
    const order = await prisma.order.findFirstOrThrow({
      where: { userId: a.user.id },
    });
    expect(order.customFields).toEqual([
      { key: 'table_number', label: 'Table number', value: '7' },
    ]);
  });

  it("can't set fields on another account's tool", async () => {
    const a = await newAccount('fields-owner');
    const b = await newAccount('fields-other');
    const tool = await prisma.tool.findFirstOrThrow({
      where: { userId: a.user.id, type: 'order' },
    });
    await expect(
      tools.setOrderFields(b.user.id, tool.id, [table]),
    ).rejects.toThrow('tool not found');
  });
});
