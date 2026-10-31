import { Logger } from '@nestjs/common';
import type { Tool } from '../generated/prisma/client';
import {
  ORDER_FUNCTION,
  ORDER_FUNCTION_DESCRIPTION,
  orderParameters,
  type OrderField,
} from '../orders/order-tool';
import type { OrderResult } from '../orders/orders.service';
import { argumentToString, parameterSchema, runApiRequest } from './runner';
import { resolve, type ResolvedTool } from './tools.types';

// One chat agent's attached tools for one incoming message, ported from the
// Go server's whatsapplogin/chattools.go. The definitions are resolved when
// the message arrives, so calling one is the action itself and nothing else.

const logger = new Logger('ChatToolbox');

// A tool as OpenAI declares it, which ChatOpenAI.bindTools passes on.
export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ReturnType<typeof parameterSchema | typeof orderParameters>;
  };
};

// What an agent with ordering switched on can do, for one reply.
export type ChatOrders = {
  // True when the sender's number is known, so the model needn't supply one.
  phoneKnown: boolean;
  place: (
    args: Record<string, unknown>,
    fields: OrderField[],
  ) => Promise<OrderResult>;
};

export class ChatToolbox {
  private readonly byName = new Map<string, ResolvedTool>();
  // The order placed in this reply, once there is one.
  private placed?: Promise<OrderResult>;
  // Set once the customer has agreed to the order this message.
  private orderConfirmed = false;

  private constructor(
    private readonly label: string,
    // Delivers a send_text tool's message to the person in this chat.
    private readonly send: (text: string) => Promise<unknown>,
    private readonly orders?: ChatOrders,
  ) {}

  // The toolbox for one reply, or null when the agent has nothing it can do,
  // so callers never special-case an agent that only talks. Take Order joins
  // only when orders is given, so with ordering off the model can't call it.
  static for(
    tools: Tool[],
    agentId: string,
    send: (text: string) => Promise<unknown>,
    orders?: ChatOrders,
  ): ChatToolbox | null {
    const box = new ChatToolbox(`chat agent ${agentId}`, send, orders);
    for (const row of tools) {
      const tool = resolve(row);
      if (tool.type === 'order') {
        // An older tool of the owner's may have this name; this one wins it.
        if (orders) {
          box.byName.set(ORDER_FUNCTION, {
            ...tool,
            name: ORDER_FUNCTION,
            description: ORDER_FUNCTION_DESCRIPTION,
          });
        }
        continue;
      }
      if (box.byName.has(tool.name)) {
        logger.warn(
          `${box.label} skipping tool ${tool.id} (${tool.name}): the name is already in use in this chat`,
        );
        continue;
      }
      box.byName.set(tool.name, tool);
    }
    return box.byName.size ? box : null;
  }

  // Whether this reply can place an order.
  get takesOrders() {
    return this.byName.get(ORDER_FUNCTION)?.type === 'order';
  }

  get phoneKnown() {
    return this.orders?.phoneKnown ?? false;
  }

  // What the owner has Take Order collect, when this reply can place an order.
  get orderFields(): OrderField[] {
    return this.byName.get(ORDER_FUNCTION)?.orderFields ?? [];
  }

  // The stored name and description are passed through untouched: they are
  // prompt text, and the model decides whether to call a tool on them alone.
  definitions(): ToolDefinition[] {
    return [...this.byName.values()].map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters:
          tool.type === 'order'
            ? orderParameters(this.phoneKnown, this.orderFields)
            : parameterSchema(tool),
      },
    }));
  }

  // Appended to the agent's prompt. A tool the prompt never mentions is
  // rarely called, and the rules that matter in a chat live nowhere else.
  instructions(): string {
    const lines = [...this.byName.values()].map(
      (tool) => `- ${tool.name}: ${tool.description.trim()}`,
    );
    return [
      'You can take these actions in this conversation:',
      ...lines,
      'When a request matches one of these actions, use function calling to run it straight away. ' +
        'Never type a tool call, its name or its arguments as message text: everything you write goes to the person. ' +
        'Never write that you will check, look up or send something, and never ask a question a tool could answer: there is no later moment, so a promise in text is never carried out. ' +
        'Never state a price, stock level or other fact that a tool provides unless the tool returned it in this conversation, and never say something was sent unless the tool confirmed it. ' +
        'Never quote a tool name, a URL, or raw response data back — reply with the part that answers the person, in your own words. ' +
        'If a tool reports a failure, say you could not complete that right now instead of inventing a result.',
    ].join('\n');
  }

  describe(): string {
    return `${this.byName.size} tool(s) [${[...this.byName.keys()].join(', ')}]`;
  }

  // Runs one tool call and returns the text the model reads as its result.
  // It never throws: a failure is reported as text, so the agent can say it
  // couldn't do something instead of the reply dying silently.
  async run(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.byName.get(name);
    if (!tool) return `Unknown tool "${name}".`;
    if (tool.type === 'api_request') {
      return runApiRequest(tool, args ?? {}, this.label);
    }
    if (tool.type === 'send_text') return this.sendText(tool, args ?? {});
    if (tool.type === 'order' && this.orders) {
      return JSON.stringify(await this.placeOrder(this.orders, args ?? {}));
    }
    return `Tool "${name}" is not something this conversation can do.`;
  }

  confirmOrder() {
    this.orderConfirmed = true;
  }

  // The number of the order placed in this reply, if one was.
  async placedOrderNumber() {
    const result = await this.placed;
    return result?.success ? result.order_number : undefined;
  }

  // The model sometimes calls before the customer has agreed, even with the
  // address still to come, so that is checked here, not asked of it. One reply
  // places one order: having placed it, the model may call again in other
  // words, which wouldn't count as a duplicate. A failure can be retried.
  private placeOrder(
    orders: ChatOrders,
    args: Record<string, unknown>,
  ): Promise<OrderResult> {
    if (!this.orderConfirmed) {
      return Promise.resolve({
        success: false,
        error:
          'The order was not placed: the customer has not confirmed it yet. Set out the whole order and ask if you should place it.',
      });
    }
    this.placed ??= orders.place(args, this.orderFields).then((result) => {
      if (!result.success) this.placed = undefined;
      return result;
    });
    return this.placed;
  }

  // Sends a link, an address or a reference as a WhatsApp message of its
  // own, rather than folded into the agent's reply.
  private async sendText(tool: ResolvedTool, args: Record<string, unknown>) {
    const body =
      tool.sendText?.body.trim() || argumentToString(args.message).trim();
    if (!body) {
      return 'No message was given to send. Provide the message text and call the tool again.';
    }
    try {
      await this.send(body);
    } catch (err) {
      logger.warn(
        `${this.label} tool ${tool.name} could not send a WhatsApp message: ${(err as Error).message}`,
      );
      return 'The message could not be sent. Tell them you will follow up another way.';
    }
    logger.log(`${this.label} tool ${tool.name} sent a WhatsApp message`);
    return 'The message has been sent on WhatsApp. It arrives as its own message, so do not repeat it.';
  }
}

// A WhatsApp number's country calling code → the time zone most of that
// country keeps (same table as the Go server). Codes spanning several zones
// (+1, +7, +61) are left out and fall back to UTC rather than guessed.
const COUNTRY_ZONES: Record<string, string> = {
  '20': 'Africa/Cairo',
  '212': 'Africa/Casablanca',
  '233': 'Africa/Accra',
  '234': 'Africa/Lagos',
  '254': 'Africa/Nairobi',
  '27': 'Africa/Johannesburg',
  '30': 'Europe/Athens',
  '31': 'Europe/Amsterdam',
  '32': 'Europe/Brussels',
  '33': 'Europe/Paris',
  '34': 'Europe/Madrid',
  '351': 'Europe/Lisbon',
  '353': 'Europe/Dublin',
  '36': 'Europe/Budapest',
  '39': 'Europe/Rome',
  '40': 'Europe/Bucharest',
  '41': 'Europe/Zurich',
  '43': 'Europe/Vienna',
  '44': 'Europe/London',
  '45': 'Europe/Copenhagen',
  '46': 'Europe/Stockholm',
  '47': 'Europe/Oslo',
  '48': 'Europe/Warsaw',
  '49': 'Europe/Berlin',
  '90': 'Europe/Istanbul',
  '51': 'America/Lima',
  '52': 'America/Mexico_City',
  '54': 'America/Argentina/Buenos_Aires',
  '55': 'America/Sao_Paulo',
  '56': 'America/Santiago',
  '57': 'America/Bogota',
  '58': 'America/Caracas',
  '60': 'Asia/Kuala_Lumpur',
  '62': 'Asia/Jakarta',
  '63': 'Asia/Manila',
  '65': 'Asia/Singapore',
  '66': 'Asia/Bangkok',
  '81': 'Asia/Tokyo',
  '82': 'Asia/Seoul',
  '84': 'Asia/Ho_Chi_Minh',
  '852': 'Asia/Hong_Kong',
  '86': 'Asia/Shanghai',
  '880': 'Asia/Dhaka',
  '91': 'Asia/Kolkata',
  '92': 'Asia/Karachi',
  '94': 'Asia/Colombo',
  '966': 'Asia/Riyadh',
  '965': 'Asia/Kuwait',
  '968': 'Asia/Muscat',
  '971': 'Asia/Dubai',
  '972': 'Asia/Jerusalem',
  '973': 'Asia/Bahrain',
  '974': 'Asia/Qatar',
  '977': 'Asia/Kathmandu',
};

// The zone a number's chats are dated in. Calling codes are prefix-free, so
// the first match from the longest candidate down is the only one.
export function zoneForPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').trim().replace(/^\+/, '');
  for (let size = 3; size >= 1; size--) {
    if (digits.length <= size) continue;
    const zone = COUNTRY_ZONES[digits.slice(0, size)];
    if (zone) return zone;
  }
  return 'UTC';
}

// The line the prompt carries so the agent knows what day it is. Without it
// a tool that takes a date gets the model's guess at what "tomorrow" means.
export function dateContext(now: Date, timeZone: string): string {
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).format(now);
  const date = part({
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).replace(',', '');
  const time = part({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const offset =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')
      ?.value.replace('GMT', '') || '+00:00';
  return (
    `Current date and time: ${date}, ${time} (${timeZone}, UTC${offset}). ` +
    'Work out relative dates such as today, tonight, tomorrow or this weekend from this date, ' +
    'and give dates to tools in exactly the format their parameters ask for.'
  );
}
