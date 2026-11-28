import type { BaseMessage } from '@langchain/core/messages';

// The model's own working text that must never reach a customer (2026-11-28).
// Claude Haiku 5.5 sometimes writes its reasoning as reply text instead of
// thinking it ("The user asks about experience. Per the instructions, reply
// only with the fixed line... ¡Hola!"), labels it ("[Reply in Egyptian
// Arabic]", "[Tool call: ...]"), or writes a draft and then the message. In the
// last week of November that reached customers in about 1 reply in 300, in
// every language. These pure helpers find it; reply-leak.ts removes it. Only
// @langchain/core types are used here, so the chat memory can use them too.

// The text of one model response that is meant to be sent. When the response
// has text before a later thinking block, the model wrote that text, then went
// back to thinking: it was working, and the message is what came after. A
// production reply ran "...Keep it short. Should I add the city? Keep it.<the
// message>": two text blocks either side of a thinking block, joined with no
// space. A response without thinking after its text is all message.
export function answerText(message: BaseMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content.trim();
  const lastThought = content.findLastIndex(
    (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
  );
  const textOf = (blocks: typeof content) =>
    blocks
      .map((block) =>
        block.type === 'text' && typeof block.text === 'string'
          ? block.text
          : '',
      )
      .join('')
      .trim();
  return textOf(content.slice(lastThought + 1)) || textOf(content);
}

// A note in square brackets that is plainly the model talking about the reply,
// not to the customer: "[Reply in Egyptian Arabic]", "[Note: ...]", "[Intent:
// ...]", "[Tool call: encaminhar_agendamento with {...}]", "[call_human not
// needed]", "[Retrieved notes contain ...]", "[The customer asked for
// pictures, so I'm sending ...]". A bracket that doesn't open like this (a
// link label, "[1]", "[Menu]") stays.
const NOTE_BRACKET =
  /\[\s*(?:(?:note|notes|intent|internal|system|thinking|reasoning|draft|plan|context|translation|tool|function|calling|chamando|llamando|retrieved|reply in|replying in|respond in|answer in|the (?:customer|user|client|person|reply|message|assistant|owner|instructions)|customer|user|client|i (?:should|need|will|'ll|am|can't|cannot))\b|[a-z]+_[a-z_]+\b)[^\]\n]{0,600}\]/giu;

// The reply without such notes, with the spacing they leave behind tidied.
export function withoutNoteBrackets(text: string): string {
  if (!text.includes('[')) return text;
  const cleaned = text.replace(NOTE_BRACKET, '');
  if (cleaned === text) return text;
  return cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Phrases that, in a message to a customer, are almost always the model
// talking to itself: about "the user", its instructions, rules, knowledge or
// tools, or planning the reply ("keep it short", "reply in Kazakh"). Any one
// of them only sends the reply to a closer look (reply-leak.ts), which keeps
// whatever is really for the customer, so a false alarm costs one quick model
// call, not the reply.
const NOTE_SIGNS: RegExp[] = [
  /\b(?:the|this) (?:user|client|sender)\b/i,
  /\bthe customer\b(?! (?:service|support|care|portal|account|area|number|id)\b)/i,
  /\b(?:per|according to|following|as per|from) (?:the|my) (?:instructions|rules|prompt|system prompt|guidelines|knowledge)\b/i,
  /\b(?:the|my) (?:instructions|rules|system prompt|prompt|guidelines)\b(?: (?:above|here|for))? (?:say|says|said|tell|tells|require|requires|allow|allows|state|states|mention|mentions|ask|asks|want|wants|don't|do not|doesn't)\b/i,
  /\bsystem (?:prompt|message|note|instructions?)\b/i,
  /\b(?:knowledge base|knowledge passages?|the passages|the knowledge|retrieved (?:knowledge|notes|passages|text)|provided material)\b/i,
  /\b(?:tool|function) (?:call|calls|result|results)\b/i,
  /\b(?:call_human|send_to_team|create_order|send_file|read_website|order_decision)\b/,
  /^\s*(?:note|draft|answer|final answer|final reply|intent|plan|reasoning|thinking|translation)\s*:/im,
  /\b(?:reply|respond|answer|write)(?:ing)? (?:only )?in (?:[A-Z][a-z]+ )?(?:English|Spanish|Arabic|Russian|Kazakh|Bangla|Bengali|Hindi|Urdu|Portuguese|French|Turkish|Persian|Farsi|Dari|Pashto|Indonesian|Malay|Swahili|Amharic|Uzbek|Kyrgyz|Tajik|Ukrainian|German|Italian|Nepali|Tamil|Sinhala)\b/,
  /\bkeep (?:it|this|the reply|the answer) (?:short|brief|concise|simple)\b/i,
  /\b(?:no|without) (?:greeting|re-?introduction|introduction)\b/i,
  /\b(?:greeting|introduction|presentation) (?:already|was|is) (?:done|given|sent|needed|required)\b/i,
  /\bI (?:should|shouldn't|should not|need to|must|have to) (?:reply|respond|answer|say|write|mention|add|keep|introduce|greet|repeat|avoid|invent|use|ask them|not)\b/i,
  /\b(?:the|this) (?:first|last|latest|previous|earlier) (?:message|reply|turn) (?:is|was|from)\b/i,
  /\bcurrent date(?: and time|\/time)?\s*:/i,
  /\bwork out relative dates\b/i,
  // The same in the customer's language, which the model sometimes reasons
  // in: "el usuario pregunta por...", "Respuesta directa: ...", "ده المستخدم
  // بيشتم تاني، ونظام الإهانة بيقول...". \b is ASCII-only, so these end on
  // "no letter follows" instead.
  /\b(?:el|la) (?:usuari[oa]|cliente) (?:pregunta|pide|quiere|pregunt[oó]|escribi[oó]|dice|busca)(?!\p{L})/iu,
  /\b(?:seg[uú]n|de acuerdo (?:con|a)) (?:las |mis |la )?(?:instrucciones|reglas|indicaciones)(?!\p{L})/iu,
  /\b(?:respuesta|resposta) direct[ao](?!\p{L})/iu,
  /\b(?:debo|tengo que) (?:responder|decir|preguntar|mencionar)(?!\p{L})/iu,
  /\b(?:o|a) (?:usu[aá]ri[oa]|cliente) (?:pergunta|quer|pediu|perguntou|disse|escreveu)(?!\p{L})/iu,
  /\bconforme (?:as |minhas )?(?:instru[cç][oõ]es|regras)(?!\p{L})/iu,
  /\b(?:devo|tenho que) (?:responder|dizer|perguntar|mencionar)(?!\p{L})/iu,
  /\bl['’]utilisat(?:eur|rice)\b|\ble client (?:demande|veut)\b|\bselon (?:les|mes) (?:instructions|consignes)\b/i,
  /пользовател|клиент (?:спрашивает|просит|хочет|пишет)|(?:согласно|по) инструкци/iu,
  /المستخدم(?!ين)|العميل (?:يسأل|يريد|بيسأل|عايز)|حسب التعليمات/u,
  /निर्देशों के अनुसार|यूज़र (?:पूछ|चाह)|ব্যবহারকারী (?:জানতে|জিজ্ঞেস)|গ্রাহক জানতে চাইছেন/u,
];

// English function words: a run of Latin-letter words with several of these
// in a reply written in another script is English text.
const ENGLISH =
  /^(?:the|a|an|is|are|was|to|of|and|or|in|on|for|with|it|this|that|i|i'm|i'll|should|not|no|user|customer|client|reply|answer|ask|asks|asked|wants|message|so|but|if|they|their|be|have|has|do|does|don't|about|which|what|keep|short|already|here|there|since|because)$/i;
const SENTENCE = /\n+|(?<=[.!?؟।。])\s+/;
const WORD = /\p{L}[\p{L}\p{M}'’]*/gu;

// Whether a reply written mostly in a non-Latin script holds an English
// sentence: in a Kazakh, Arabic or Bangla chat, that has been the model's
// reasoning ("The client is asking about this car... I should ask which car")
// every time. Names and brands in Latin letters are short and have no English
// function words, so they don't count.
export function hasEnglishAside(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return false;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  if (latin / letters.length > 0.75) return false;
  return text.split(SENTENCE).some((sentence) => {
    const words = [...sentence.matchAll(WORD)].map(([w]) => w);
    const latinWords = words.filter((w) => /^\p{Script=Latin}/u.test(w));
    if (latinWords.length < 6 || latinWords.length * 2 < words.length) {
      return false;
    }
    return latinWords.filter((w) => ENGLISH.test(w)).length >= 3;
  });
}

// Whether a reply may hold the model's working text and needs a closer look.
export function looksLikeNotes(
  text: string,
  toolNames: string[] = [],
): boolean {
  if (NOTE_SIGNS.some((sign) => sign.test(text))) return true;
  if (toolNames.some((name) => name.length > 3 && text.includes(name))) {
    return true;
  }
  return hasEnglishAside(text);
}

const normalized = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const SHINGLE_WORDS = 8;

function shingles(text: string): string[] {
  const words = normalized(text).split(' ').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
    out.push(words.slice(i, i + SHINGLE_WORDS).join(' '));
  }
  return out;
}

// A reply this much of which is the owner's prompt word for word, and that
// long, is the prompt itself: live, a customer asking "where is the owner?" got
// all 8,000 characters of it, and another got 15,000. A greeting or a price
// list copied from the prompt is far shorter.
const PROMPT_DUMP_WORDS = 150;
const PROMPT_DUMP_SHARE = 0.8;
// Shorter copies of the prompt may be its rules ("ORDER RULES 1. collect the
// customer's name...") or the greeting it gives: the closer look tells them
// apart.
const PROMPT_COPY_WORDS = 40;
const PROMPT_COPY_SHARE = 0.5;

// How much of the instructions a reply repeats: 'all' when it is the owner's
// prompt itself, which never goes out; 'some' when part of it may be, for the
// closer look; '' when none. `own` is text that is never for a customer (the
// rules this server adds, the date note): any 8 words in a row from it count.
// `owner` is the owner's prompt, whose prices, lists and fixed lines a reply
// rightly copies, so only a long copy counts.
export function repeatsInstructions(
  reply: string,
  own: string,
  owner: string,
): 'all' | 'some' | '' {
  const replyShingles = shingles(reply);
  if (!replyShingles.length) return '';
  const ownerSet = new Set(shingles(owner));
  const copied = replyShingles.filter((s) => ownerSet.has(s)).length;
  const share = copied / replyShingles.length;
  if (copied >= PROMPT_DUMP_WORDS && share >= PROMPT_DUMP_SHARE) return 'all';
  if (copied >= PROMPT_COPY_WORDS && share >= PROMPT_COPY_SHARE) return 'some';
  const ownSet = new Set(shingles(own));
  return replyShingles.some((s) => ownSet.has(s)) ? 'some' : '';
}

// A draft cut into pieces at line breaks and sentence ends, each piece keeping
// what follows it, so any of them joined back together are exactly the text
// they came from. A sentence end is only one where a new sentence starts:
// "Rs. 299" and "1.5 kg" stay whole, "...answer.¡Hola!" and "Keep it.للأسف"
// (two blocks joined with no space) split. A label opening a line ("Answer:",
// "Respuesta:") is a piece of its own, so dropping it keeps what it labels.
export function draftPieces(text: string): string[] {
  const pieces: string[] = [];
  const end =
    /(?:^|(?<=\n))[ \t]*(?:[Dd]raft|DRAFT|[Aa]nswer|ANSWER|[Ff]inal [Aa]nswer|[Ff]inal [Rr]eply|[Rr]eply|[Rr]esponse|[Rr]espuesta|[Rr]esposta|[Rr]éponse|[Оо]твет)[ \t]*:[ \t]*|\n+|[.!?؟।。…]+(?:\s+(?=[^\p{N}])|(?=[¡¿*_~\p{Lu}])|(?=[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}]))/gu;
  let start = 0;
  for (const match of text.matchAll(end)) {
    const stop = match.index + match[0].length;
    if (stop >= text.length) break;
    if (text.slice(start, stop).trim()) {
      pieces.push(text.slice(start, stop));
      start = stop;
    }
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}
