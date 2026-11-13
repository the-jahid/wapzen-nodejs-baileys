import type { toResource } from './orders.types';

type OrderResource = ReturnType<typeof toResource>;

// WhatsApp takes far longer messages; this keeps a runaway order readable.
const MAX_NOTICE_CHARS = 3000;

// The WhatsApp message the agent's number sends to the owner's order-alert
// number (chat_agents.order_notify_phone) when an order is placed or changed.
// Built from the saved order, not by the model, so it says exactly what was
// stored: the details the owner's order instructions asked for are the
// order's own fields. Blank fields are left out.
export function orderNotice(
  order: OrderResource,
  { updated, agentName }: { updated: boolean; agentName: string },
): string {
  const heading = updated
    ? `✏️ *Order #${order.order_number} changed*`
    : `🛒 *New order #${order.order_number}*`;
  const line = (label: string, value: string | null | undefined) =>
    value?.trim() ? `*${label}:* ${value.trim()}` : '';

  const items = order.items
    .filter((item) => item.name?.trim())
    .map((item) => {
      const quantity = item.quantity ? `${item.quantity} × ` : '';
      const note = item.note?.trim() ? ` (${item.note.trim()})` : '';
      return `• ${quantity}${item.name.trim()}${note}`;
    });

  const blocks = [
    [heading, agentName.trim() ? `Taken by ${agentName.trim()}` : ''],
    [
      line('Customer', order.customer_name),
      line('Phone', order.phone),
      line('Email', order.email),
      line('Delivery address', order.delivery_address),
    ],
    items.length ? ['*Items*', ...items] : [],
    [line('Order', order.description)],
    order.custom_fields.map((field) => line(field.label, field.value)),
  ];
  const text = blocks
    .map((block) => block.filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
  return text.length > MAX_NOTICE_CHARS
    ? `${text.slice(0, MAX_NOTICE_CHARS - 1)}…`
    : text;
}
