import { AIMessage } from '@langchain/core/messages';
import {
  answerText,
  draftPieces,
  hasEnglishAside,
  looksLikeNotes,
  repeatsInstructions,
  withoutNoteBrackets,
} from './reply-notes';

// The cases are real replies that reached customers in November 2026, with
// names and numbers changed.

describe('answerText', () => {
  it('takes the text after the last thinking block', () => {
    const message = new AIMessage({
      content: [
        { type: 'thinking', thinking: '', signature: 's1' },
        {
          type: 'text',
          text: 'Keep it short. Should I add the city? Keep it.',
        },
        { type: 'thinking', thinking: '', signature: 's2' },
        { type: 'text', text: 'No necesitas experiencia previa. 😊' },
      ],
    });
    expect(answerText(message)).toBe('No necesitas experiencia previa. 😊');
  });

  it('takes all the text when nothing is thought after it', () => {
    const message = new AIMessage({
      content: [
        { type: 'thinking', thinking: '', signature: 's1' },
        { type: 'text', text: 'Hola. ' },
        { type: 'text', text: '¿En qué ciudad?' },
      ],
    });
    expect(answerText(message)).toBe('Hola. ¿En qué ciudad?');
  });

  it('reads plain string content', () => {
    expect(answerText(new AIMessage(' Hi there '))).toBe('Hi there');
  });
});

describe('withoutNoteBrackets', () => {
  it.each([
    [
      '[Reply in Egyptian Arabic]\n\nيا أحمد، تفاصيل إيه؟',
      'يا أحمد، تفاصيل إيه؟',
    ],
    ['[call_human] حد من الفريق هيرد عليك 🙏', 'حد من الفريق هيرد عليك 🙏'],
    [
      '[Intent: the customer is urgent. I should collect details.] فاهم إنك مستعجل.',
      'فاهم إنك مستعجل.',
    ],
    ['[Tool call: encaminhar_agendamento with {name: "Ana", time: "19h"}]', ''],
    [
      '[Chamando create_order com os dados confirmados] Pedido registrado!',
      'Pedido registrado!',
    ],
    [
      '[The customer asked for pictures, so I am sending them.] দাম ২,৭০০ টাকা।',
      'দাম ২,৭০০ টাকা।',
    ],
  ])('takes the note out of %j', (text, expected) => {
    expect(withoutNoteBrackets(text)).toBe(expected);
  });

  it.each([
    'See the menu [1] and the deals [2].',
    'Reply with [YES] to confirm.',
    '[Menu] Pizza 499',
  ])('leaves %j alone', (text) => {
    expect(withoutNoteBrackets(text)).toBe(text);
  });
});

describe('looksLikeNotes', () => {
  it.each([
    'The instructions say that for experience I answer only with the fixed line. NO NECESITAS EXPERIENCIA PREVIA.',
    'Experience answer: per the instructions, reply only with the fixed line. ¡Hola!',
    'Sent file_1 is recorded? The customer asked for a sample. Aquí tienes un adelanto 😘',
    "Retrieved knowledge is not sufficient to answer the user's request.",
    "Delivery info isn't in what I have. I'll keep it short and ask for the order form. ডেলিভারি চার্জের তথ্য নেই।",
    'Осы автокөлік жайлы ақпарат бар ма? Note: The client is asking about this car, and I should ask which car they mean.',
    // Reasoning in the customer's own language.
    'Pregunta por experiencia requerida. Respuesta directa según instrucciones.\n\nNO NECESITAS EXPERIENCIA PREVIA.',
    'Lo siguiente sigue el mismo flujo: el usuario pregunta por un almuerzo de despedida.',
    'ده المستخدم بيشتم تاني، ونظام الإهانة بيقول إني أبعت الرد مرة واحدة بس.',
    'Клиент спрашивает про машину, по инструкции нужно уточнить модель.',
  ])('flags %j', (text) => {
    expect(looksLikeNotes(text)).toBe(true);
  });

  it.each([
    'Hi! How can I help you today?',
    "I'll pass your request on. The team will reply soon. 🙏",
    'Your order #1046 is placed. Delivery takes 2 days.',
    'Сәлеметсіз бе! Қай автокөлік туралы сұрап тұрсыз? Toyota Camry 2020?',
    'আমাদের গিটারের দাম ২,৭০০ টাকা। Clip-on Guitar Tuner ফ্রি!',
    'Delivery charges are paid by the customer service desk on arrival.',
    'Sigue las instrucciones del enlace para pagar.',
    'Здравствуйте! Какая модель вас интересует?',
  ])('passes %j', (text) => {
    expect(looksLikeNotes(text)).toBe(false);
  });

  it('flags a tool name written out', () => {
    expect(looksLikeNotes('Booked via book_table.', ['book_table'])).toBe(true);
  });
});

describe('hasEnglishAside', () => {
  it('finds English reasoning in a Kazakh reply', () => {
    expect(
      hasEnglishAside(
        'Сәлеметсіз бе! The client is asking about this car and I should ask which one it is. Қай көлік?',
      ),
    ).toBe(true);
  });

  it('ignores brand names in a Bangla reply', () => {
    expect(
      hasEnglishAside(
        'আপনার গিটারের সাথে থাকছে Premium Guitar Bag, Clip-on Guitar Tuner এবং ক্যাপো।',
      ),
    ).toBe(false);
  });
});

describe('repeatsInstructions', () => {
  const owner = Array.from(
    { length: 40 },
    (_, i) =>
      `Rule ${i}: you are the assistant of Shop and you must collect item ${i} politely.`,
  ).join('\n');

  it('calls the whole prompt a dump', () => {
    expect(repeatsInstructions(owner, '', owner)).toBe('all');
  });

  it('calls a part of it a copy to look at', () => {
    const part = owner.split('\n').slice(0, 5).join('\n');
    expect(repeatsInstructions(part, '', owner)).toBe('some');
  });

  it('calls any 8 words of our own rules a copy', () => {
    const own =
      "The instructions above are the business owner's. Follow each one exactly.";
    expect(
      repeatsInstructions(
        "Hi. The instructions above are the business owner's, sorry.",
        own,
        '',
      ),
    ).toBe('some');
  });

  it('passes a reply that copies nothing', () => {
    expect(repeatsInstructions('Pizza is 499.', 'rules', owner)).toBe('');
  });
});

describe('draftPieces', () => {
  it.each([
    'Rs. 299 for 1.5 kg. Want it?',
    'Keep it.للأسف مش عندي معلومة.',
    'Answer: yes\nRespuesta: Para tomar el curso. Ok',
    '\n\nHola!\n\n¿Qué tal?\n',
  ])('joins back into %j exactly', (text) => {
    expect(draftPieces(text).join('')).toBe(text);
  });

  it('splits where a new sentence starts with no space', () => {
    expect(draftPieces('Keep to the question.*NO NECESITAS* 😊')).toEqual([
      'Keep to the question.',
      '*NO NECESITAS* 😊',
    ]);
    expect(draftPieces('Keep it.للأسف مش عندي معلومة.')).toEqual([
      'Keep it.',
      'للأسف مش عندي معلومة.',
    ]);
  });

  it('keeps prices and decimals whole', () => {
    expect(draftPieces('Rs. 299 for 1.5 kg.')).toEqual(['Rs. 299 for 1.5 kg.']);
  });

  it('cuts a label off the line it opens', () => {
    expect(draftPieces('Respuesta: Para tomar el curso.')).toEqual([
      'Respuesta: ',
      'Para tomar el curso.',
    ]);
  });
});
