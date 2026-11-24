import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import { asciiDigits } from './digits';
import { chatModel } from './reply-agent';

// Keeps a chat agent to the reply language its owner set (2026-11-23). An
// owner wrote "always reply in Arabic" and the agent sometimes answered in
// English. The prompt alone doesn't hold it: once one English reply is in the
// chat (the owner answering from the phone, a slip), the next one copied it 6
// times in 10 even with a language rule in the prompt, and per-message
// reminders made the model write its own deliberation into the reply. So the
// code checks: the owner's language is read from the prompt once, each reply's
// script is compared with it, and a reply in the wrong one is rewritten before
// it is sent and saved, which also keeps the chat history in the right
// language.

const LANGUAGE_FUNCTION = 'reply_language';
const LOOKUP_MAX_TOKENS = 1000;
// The rewrite thinks too, and a long reply has to fit after it.
const REWRITE_MAX_TOKENS = 4000;
// Languages read from prompts kept in memory, keyed on a hash of the prompt.
const MAX_PROMPTS = 2_000;
// A reply with fewer letters than this ("OK 👍", an order number) is left alone.
const MIN_LETTERS = 4;
// Rewrites tried before the reply goes out as it was. A live rewrite turned
// "1 to 2 days" into "2 to 3 days", so each one has to keep every number.
const REWRITE_ATTEMPTS = 2;

// The numbers a message states, whatever digits it writes them in ("٢٥٠" is
// 250), so a rewrite can be checked for a changed price or time.
export function numbersIn(text: string): string[] {
  return (asciiDigits(text).match(/\d+/g) ?? [])
    .map((n) => String(Number(n)))
    .sort();
}

// Numbers a rewrite may write as a word instead: Arabic says "two bottles" with
// one word (زجاجتين), and a live rewrite of "2 bottles" was refused for it.
const NUMBERS_AS_WORDS = new Set(['1', '2']);

// Whether a rewrite keeps the reply's numbers: it adds none, and drops none
// but a 1 or a 2. "1 to 2 days" rewritten as "2 to 3 days" adds a 3.
export function sameNumbers(reply: string, rewritten: string): boolean {
  const left = numbersIn(reply);
  for (const n of numbersIn(rewritten)) {
    const at = left.indexOf(n);
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return left.every((n) => NUMBERS_AS_WORDS.has(n));
}

const LOOKUP_PROMPT = [
  "You read a business owner's instructions for their WhatsApp assistant and record the language its replies must be written in.",
  'Set language to the English name of that language (such as "Arabic") only when the instructions require every reply in it, whatever language the customer writes in, as in "always reply in Arabic" or "only answer in Spanish".',
  "Set language to an empty string when they name no reply language, let replies follow the customer's language, allow several languages, or only describe the language the customers speak.",
  'The language the instructions are written in does not count: English instructions saying "reply in Arabic" mean Arabic.',
].join('\n');

// A business assistant's WhatsApp message, rewritten in the owner's language.
// The job goes in the user turn with the message: with the system prompt
// alone, the model handed an English message back unchanged.
const REWRITE_SYSTEM =
  "You translate a business assistant's WhatsApp messages. You never answer them or add to them.";
const rewriteRequest = (language: string, message: string) =>
  [
    `Rewrite this WhatsApp message entirely in ${language}, as the same business assistant would write it to the customer.`,
    'Keep the meaning and the tone. Keep every number exactly, written in digits as it is in the message, and keep prices, dates, order numbers, links, emails, phone numbers, emoji, formatting and line breaks exactly; product and brand names may stay as they are.',
    'Return only the rewritten message, with nothing before or after it.',
    '',
    '<message>',
    message,
    '</message>',
  ].join('\n');

// The script each language is written in. Any language not listed here is
// taken to be written in Latin letters.
const SCRIPT_BY_LANGUAGE: Record<string, RegExp> = {};
const script = (re: RegExp, ...languages: string[]) => {
  for (const language of languages) SCRIPT_BY_LANGUAGE[language] = re;
};
script(
  /\p{Script=Arabic}/u,
  'arabic',
  'urdu',
  'persian',
  'farsi',
  'pashto',
  'dari',
  'sindhi',
  'uyghur',
);
script(/\p{Script=Bengali}/u, 'bengali', 'bangla', 'assamese');
script(/\p{Script=Devanagari}/u, 'hindi', 'marathi', 'nepali', 'sanskrit');
script(
  /\p{Script=Cyrillic}/u,
  'russian',
  'ukrainian',
  'bulgarian',
  'belarusian',
  'kazakh',
  'kyrgyz',
  'macedonian',
  'mongolian',
  'tajik',
);
script(/\p{Script=Greek}/u, 'greek');
script(/\p{Script=Hebrew}/u, 'hebrew', 'yiddish');
script(/\p{Script=Thai}/u, 'thai');
script(/\p{Script=Hangul}/u, 'korean');
script(/\p{Script=Han}/u, 'chinese', 'mandarin', 'cantonese');
script(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, 'japanese');
script(/\p{Script=Tamil}/u, 'tamil');
script(/\p{Script=Telugu}/u, 'telugu');
script(/\p{Script=Gujarati}/u, 'gujarati');
script(/\p{Script=Gurmukhi}/u, 'punjabi');
script(/\p{Script=Kannada}/u, 'kannada');
script(/\p{Script=Malayalam}/u, 'malayalam');
script(/\p{Script=Sinhala}/u, 'sinhala');
script(/\p{Script=Ethiopic}/u, 'amharic', 'tigrinya');
script(/\p{Script=Georgian}/u, 'georgian');
script(/\p{Script=Armenian}/u, 'armenian');
script(/\p{Script=Khmer}/u, 'khmer');
script(/\p{Script=Lao}/u, 'lao');
script(/\p{Script=Myanmar}/u, 'burmese', 'myanmar');
const LATIN = /\p{Script=Latin}/u;
const LATIN_LANGUAGES = new Set([
  'english',
  'spanish',
  'portuguese',
  'french',
  'german',
  'italian',
  'dutch',
  'indonesian',
  'malay',
  'turkish',
  'vietnamese',
  'polish',
  'romanian',
  'swedish',
  'norwegian',
  'danish',
  'finnish',
  'czech',
  'slovak',
  'slovenian',
  'hungarian',
  'croatian',
  'bosnian',
  'albanian',
  'lithuanian',
  'latvian',
  'estonian',
  'catalan',
  'basque',
  'galician',
  'irish',
  'welsh',
  'icelandic',
  'swahili',
  'tagalog',
  'filipino',
  'somali',
  'hausa',
  'yoruba',
  'igbo',
  'zulu',
  'xhosa',
  'afrikaans',
  'azerbaijani',
  'uzbek',
  'turkmen',
  'maltese',
  'javanese',
  'sundanese',
  'cebuano',
  'malagasy',
]);

// The language a lookup named, as one of the languages above, or '' for any
// other answer: the guard only ever acts on a language it knows the script of.
// "Egyptian Arabic" is Arabic; "" (the model once wrote two quote marks),
// "none" or a language not listed is no language.
export function knownLanguage(raw: string): string {
  const words = raw.toLowerCase().match(/\p{L}+/gu) ?? [];
  const word = words.find(
    (w) => w in SCRIPT_BY_LANGUAGE || LATIN_LANGUAGES.has(w),
  );
  return word ? word[0].toUpperCase() + word.slice(1) : '';
}

// Links, emails and handles are Latin whatever the language: not counted.
const NOT_WORDS = /\bhttps?:\/\/\S+|\bwww\.\S+|\S+@\S+\.\S+/gi;
// A word, vowel signs included (Bengali and Hindi write them as marks).
const WORD = /\p{L}[\p{L}\p{M}]*/gu;
const SENTENCE_END = /\n+|(?<=[.!?؟।。])\s+/;
const UPPER_FIRST = /^\p{Lu}/u;

// Whether a reply is plainly not written in the language: some sentence of it
// has more foreign words than words in the language's script. A word in Latin
// letters that starts with a capital ("Amber Night", "SAR", "John") is a name
// in a reply in another script, not English, so it counts for neither side;
// "Amber Night costs 220 SAR." has one foreign word, "costs", and none in
// Arabic. Two languages in the same script (English and Spanish) can't be told
// apart this way, so that is never called wrong.
export function wrongLanguage(text: string, language: string): boolean {
  const name = knownLanguage(language).toLowerCase();
  if (!name) return false;
  const want = SCRIPT_BY_LANGUAGE[name] ?? LATIN;
  const clean = text.replace(NOT_WORDS, ' ');
  if ((clean.match(/\p{L}/gu) ?? []).length < MIN_LETTERS) return false;
  return clean.split(SENTENCE_END).some((sentence) => {
    let own = 0;
    let foreign = 0;
    for (const [word] of sentence.matchAll(WORD)) {
      if (want.test(word[0])) own++;
      else if (!LATIN.test(word[0]) || !UPPER_FIRST.test(word)) foreign++;
    }
    return foreign > own;
  });
}

export function createLanguageGuard(apiKey: string) {
  const lookupModel = chatModel(apiKey, LOOKUP_MAX_TOKENS).bindTools(
    [
      {
        type: 'function',
        function: {
          name: LANGUAGE_FUNCTION,
          description: 'Records the language every reply must be written in.',
          parameters: {
            type: 'object',
            properties: { language: { type: 'string' } },
            required: ['language'],
          },
        },
      },
    ],
    { tool_choice: LANGUAGE_FUNCTION },
  );
  const rewriteModel = chatModel(apiKey, REWRITE_MAX_TOKENS);
  const languages = new Map<string, Promise<string>>();

  // The language every reply of this prompt must be in, or '' when the owner
  // set none. Asked once per prompt; a failed lookup is asked again next time.
  const languageOf = (prompt: string): Promise<string> => {
    const text = prompt.trim();
    if (!text) return Promise.resolve('');
    const key = createHash('sha256').update(text).digest('hex');
    const known = languages.get(key);
    if (known) return known;
    const lookup = lookupModel
      .invoke([new SystemMessage(LOOKUP_PROMPT), new HumanMessage(text)])
      .then((reply) => {
        const language: unknown = reply.tool_calls?.[0]?.args?.language;
        return typeof language === 'string' ? knownLanguage(language) : '';
      })
      .catch((err: Error) => {
        languages.delete(key);
        throw err;
      });
    if (languages.size >= MAX_PROMPTS) {
      const [oldest] = languages.keys();
      languages.delete(oldest);
    }
    languages.set(key, lookup);
    return lookup;
  };

  const rewrite = async (reply: string, language: string) =>
    (
      await rewriteModel.invoke([
        new SystemMessage(REWRITE_SYSTEM),
        new HumanMessage(rewriteRequest(language, reply)),
      ])
    ).text
      .replace(/^\s*<message>|<\/message>\s*$/g, '')
      .trim();

  // The reply in the owner's language: as it is when it already is (or none
  // is set), rewritten when it plainly isn't. A rewrite still in the wrong
  // language, or one that lost or changed a number, is tried once more and
  // then dropped, and the reply goes out as it was: a wrong price is worse
  // than the wrong language.
  const inLanguage = async (reply: string, language: string) => {
    if (!language || !wrongLanguage(reply, language)) {
      return { text: reply, rewritten: false };
    }
    for (let attempt = 0; attempt < REWRITE_ATTEMPTS; attempt++) {
      const rewritten = await rewrite(reply, language);
      if (
        rewritten &&
        !wrongLanguage(rewritten, language) &&
        sameNumbers(reply, rewritten)
      ) {
        return { text: rewritten, rewritten: true };
      }
    }
    return { text: reply, rewritten: false };
  };

  return { languageOf, inLanguage };
}
