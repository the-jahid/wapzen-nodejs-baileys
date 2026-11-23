import { toWhatsAppFormat } from './whatsapp-format';

describe('toWhatsAppFormat', () => {
  it('turns Markdown bold into WhatsApp bold', () => {
    expect(toWhatsAppFormat('**3. SANDWICH**')).toBe('*3. SANDWICH*');
    expect(toWhatsAppFormat('***2. BURGER***')).toBe('*2. BURGER*');
    expect(toWhatsAppFormat('__Menu__ today')).toBe('*Menu* today');
  });

  it('keeps WhatsApp marks as they are', () => {
    const text = '*4. COFFEE*\n1. Hot Coffee – ₹59\n_fresh_ ~old~';
    expect(toWhatsAppFormat(text)).toBe(text);
  });

  it('turns headings, strikes, links and bullets into WhatsApp text', () => {
    expect(toWhatsAppFormat('## **Menu**\n* Veg Roll – ₹79')).toBe(
      '*Menu*\n- Veg Roll – ₹79',
    );
    expect(toWhatsAppFormat('~~₹99~~ ₹89')).toBe('~₹99~ ₹89');
    expect(toWhatsAppFormat('[Order](https://x.io/o)')).toBe(
      'Order: https://x.io/o',
    );
  });

  it('leaves snake_case and maths alone', () => {
    expect(toWhatsAppFormat('order_id 2 * 3')).toBe('order_id 2 * 3');
  });
});
