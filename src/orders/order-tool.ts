// How the built-in Take Order tool reaches the model: the create_order function
// and the part of the prompt that goes with it. Kept apart from the stored tool
// row, whose name and description are written for the dashboard.

export const ORDER_FUNCTION = 'create_order';

export const ORDER_FUNCTION_DESCRIPTION =
  'Places an order for the customer in this conversation. Call it only after the customer has confirmed the order summary.';

// One detail create_order collects. A key from DEFAULT_ORDER_FIELDS fills that
// column of the order; any other is a field the owner added.
export type OrderField = { key: string; label: string; required: boolean };

// What an account collects until its owner changes the list.
export const DEFAULT_ORDER_FIELDS: OrderField[] = [
  { key: 'customer_name', label: 'Customer name', required: true },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'description', label: 'Description', required: true },
  { key: 'email', label: 'Email', required: false },
  { key: 'items', label: 'Items', required: false },
  { key: 'delivery_address', label: 'Delivery address', required: false },
];

const NAME_DESCRIPTION = "The customer's name.";
const PHONE_DESCRIPTION =
  "The customer's phone number, with the country code if they gave one.";
const KNOWN_PHONE_DESCRIPTION =
  'Only if the customer gave a different number: their WhatsApp number is used otherwise.';

const BUILT_IN_KEYS = new Set(DEFAULT_ORDER_FIELDS.map((field) => field.key));

export function isBuiltInField(key: string) {
  return BUILT_IN_KEYS.has(key);
}

function fieldSchema(field: OrderField, phoneKnown: boolean) {
  switch (field.key) {
    case 'customer_name':
      return { type: 'string', description: NAME_DESCRIPTION };
    case 'phone':
      return {
        type: 'string',
        description: phoneKnown ? KNOWN_PHONE_DESCRIPTION : PHONE_DESCRIPTION,
      };
    case 'email':
      return {
        type: 'string',
        description: "The customer's email address, if they gave one.",
      };
    case 'description':
      return {
        type: 'string',
        description:
          'What the customer wants, in full: items, quantity, size, address and any notes.',
      };
    case 'items':
      return {
        type: 'array',
        description: 'The items ordered, one entry per item.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            quantity: { type: 'number' },
            note: { type: 'string' },
          },
          required: ['name'],
        },
      };
    case 'delivery_address':
      return {
        type: 'string',
        description: 'Where to deliver the order, if it is being delivered.',
      };
    default:
      return { type: 'string', description: field.label };
  }
}

// The JSON Schema of create_order. On WhatsApp the sender's number is usually
// known, and then phone is optional: when it is required the model invents one
// rather than leave it out.
export function orderParameters(
  phoneKnown: boolean,
  fields: OrderField[] = DEFAULT_ORDER_FIELDS,
) {
  return {
    type: 'object' as const,
    properties: Object.fromEntries(
      fields.map((field) => [field.key, fieldSchema(field, phoneKnown)]),
    ),
    required: fields
      .filter((f) => f.required && !(f.key === 'phone' && phoneKnown))
      .map((f) => f.key),
  };
}

// The required details as the prompts name them. A phone number isn't one of
// them: orderPrompt deals with it, and the check after it can't see the sender's.
export function requiredDetails(fields: OrderField[]) {
  const names: Record<string, string> = {
    customer_name: 'the name',
    description: 'what they want',
  };
  return fields
    .filter((field) => field.required && field.key !== 'phone')
    .map((field) => names[field.key] ?? field.label);
}

// The prompt section for an agent that takes orders. The owner's instructions
// come first and win; the rules hold whatever they say. The toolbox tells the
// model to run tools straight away, which is wrong for an order, hence the
// opening exception.
export function orderPrompt(
  instructions: string,
  phoneKnown: boolean,
  fields: OrderField[] = DEFAULT_ORDER_FIELDS,
) {
  const owner = instructions.trim();
  const required = requiredDetails(fields);
  const phone = fields.find((field) => field.key === 'phone');
  // Fields the owner added are there to be asked for, even optional ones.
  const extras = fields
    .filter((field) => !field.required && !isBuiltInField(field.key))
    .map((field) => field.label);
  return [
    `You take orders in this chat with the ${ORDER_FUNCTION} function. Unlike other actions, it is not run straight away: follow these steps.`,
    owner ? `The business's order instructions:\n${owner}` : '',
    [
      'How to take an order:',
      '1. Ask for the required details one at a time: ' +
        [...required, 'anything the instructions above ask for'].join(', ') +
        '.' +
        (extras.length
          ? ` Also ask once for: ${extras.join(', ')}. They may skip these.`
          : '') +
        (!phone
          ? " Don't ask for a phone number unless the instructions say to."
          : phoneKnown
            ? " Their WhatsApp number is already known, so don't ask for a phone number unless the instructions say to."
            : phone.required
              ? ' Also ask for a phone number.'
              : '') +
        ' Never invent a detail the customer did not give, and never ask for an optional detail twice.',
      '2. When you have the details, show the whole order once and ask if you should place it. Show it only once.',
      `3. The moment the customer agrees in any words or language (yes, ok, correct, place it, হ্যাঁ, ঠিক আছে, জি), your whole response is a ${ORDER_FUNCTION} function call, with no text. Do not summarize again, do not ask again, do not ask for anything else: that is a mistake.`,
      "4. After it returns success, give the order number, like: Your order #1024 is placed. If it reports a problem, ask for the field it names or say the order couldn't be placed right now.",
      `No order exists until ${ORDER_FUNCTION} returns success, so never say you are placing or have placed an order. Don't call it for questions or for someone who is only browsing.`,
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

// For an agent whose owner attached Take Order and left it off. It would
// otherwise cheerfully "take" an order it can't place. Only that explicit choice
// gets this: added to every agent it made one that collects orders through its
// own prompt refuse them (19 in 30, live), even with the exception below.
export const ORDERS_OFF_PROMPT =
  'Order taking is not switched on in this chat. Unless the instructions above or one of your actions give you a way to take orders, ' +
  "don't offer to take an order or say one has been placed. If someone asks to order, politely tell them ordering isn't available here.";
