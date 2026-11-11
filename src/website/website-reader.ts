import { Logger } from '@nestjs/common';
import { guardedGet } from '../tools/runner';

// Reads pages of a chat agent owner's website for the agent's replies. Only
// pages on the owner's own site are read: the model picks which page, so a
// link to anywhere else is refused here rather than trusted to the prompt.
// Requests go through the tool runner's guard, so a site whose name resolves
// to an internal address is refused like an API tool would be.

const logger = new Logger('WebsiteReader');

export const READ_WEBSITE_FUNCTION = 'read_website';

// The whole exchange, redirects included. A reply waits for it.
const FETCH_TIMEOUT_MS = 8000;
// A page read this recently is reused, so a chat asking several questions
// doesn't fetch the same page for every message.
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX_PAGES = 300;
// How much of a page the model is given. The home page rides along with every
// reply, so it gets less than a page the model asked for.
export const PAGE_TEXT_CHARS = 6000;
export const HOME_TEXT_CHARS = 4000;
const MAX_LINKS = 50;
const LINK_LABEL_CHARS = 60;
// Below this a page is taken to be drawn by JavaScript, which isn't run here.
const THIN_PAGE_CHARS = 200;

const USER_AGENT =
  'Mozilla/5.0 (compatible; WapzenAgent/1.0; reads this site for its owner)';
const NOT_A_PAGE =
  /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|css|js|mjs|json|xml|pdf|zip|rar|gz|mp3|mp4|m4a|wav|webm|mov|avi|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|apk|exe|dmg)$/i;

// One page, read.
export type WebsitePage = {
  url: string;
  title: string;
  description: string;
  text: string;
  links: { label: string; url: string }[];
  contacts: string[];
};

// The site's address as a URL, or null when what the owner typed isn't one.
// "shop.com" is read as https://shop.com.
export function siteRoot(raw: string | null | undefined): URL | null {
  const typed = (raw ?? '').trim();
  if (!typed) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(typed)
    ? typed
    : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // A bare word ("shop") isn't a website anyone can reach.
  if (!url.hostname.includes('.') && !url.hostname.includes(':')) return null;
  url.hash = '';
  return url;
}

// The same site whether or not "www." is in front, and over http or https.
function siteHost(url: URL) {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

export function onSite(url: URL, root: URL) {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    siteHost(url) === siteHost(root)
  );
}

const cache = new Map<string, { at: number; page: WebsitePage }>();

// Reads one page of the site, the home page (the address the owner gave) when
// no page is named. Throws a message meant for the model when it can't.
export async function readWebsitePage(
  root: URL,
  requested?: string,
): Promise<WebsitePage> {
  const wanted = requested?.trim();
  let url: URL;
  try {
    url = wanted ? new URL(wanted, root) : new URL(root);
  } catch {
    throw new Error('That is not a page address.');
  }
  url.hash = '';
  if (!onSite(url, root)) {
    throw new Error(
      `Only pages on ${root.hostname} can be read. Pick one of the links its pages list.`,
    );
  }
  if (NOT_A_PAGE.test(url.pathname)) {
    throw new Error('That address is a file, not a page that can be read.');
  }

  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;

  let res: Awaited<ReturnType<typeof guardedGet>>;
  try {
    res = await guardedGet(
      url,
      {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en;q=0.9,*;q=0.8',
      },
      FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    logger.warn(`could not read ${redacted(url)}: ${(err as Error).message}`);
    throw new Error('The website could not be reached right now.');
  }
  if (!onSite(res.url, root)) {
    throw new Error(`That page moved off ${root.hostname}, so it wasn't read.`);
  }
  if (res.status >= 400) {
    throw new Error(
      res.status === 404
        ? 'That page does not exist on the website.'
        : `The website refused that page (status ${res.status}).`,
    );
  }
  const type = res.contentType.toLowerCase();
  let page: WebsitePage;
  if (type.includes('html') || (!type && /<html|<body/i.test(res.body))) {
    page = parseHtml(res.body, res.url, root);
  } else if (type.startsWith('text/plain')) {
    page = {
      url: res.url.toString(),
      title: '',
      description: '',
      text: tidy(res.body),
      links: [],
      contacts: [],
    };
  } else {
    throw new Error('That address is a file, not a page that can be read.');
  }

  cache.delete(key);
  cache.set(key, { at: Date.now(), page });
  while (cache.size > CACHE_MAX_PAGES) {
    const [oldest] = cache.keys();
    cache.delete(oldest);
  }
  return page;
}

// A page as the model reads it: its text, then the site's pages it links to,
// which the model can ask for next.
export function pageForModel(page: WebsitePage, maxChars = PAGE_TEXT_CHARS) {
  const text =
    page.text.length > maxChars
      ? `${page.text.slice(0, maxChars)}\n… (the rest of the page was cut)`
      : page.text;
  const parts = [`Page: ${page.url}`];
  if (page.title) parts.push(`Title: ${page.title}`);
  if (page.description) parts.push(`Summary: ${page.description}`);
  parts.push(
    '',
    page.text.length < THIN_PAGE_CHARS
      ? `${text}\n(The page has almost no text that can be read here; its content may be drawn by JavaScript.)`
      : text,
  );
  if (page.contacts.length) {
    parts.push('', `Contact links on the page: ${page.contacts.join(', ')}`);
  }
  if (page.links.length) {
    parts.push(
      '',
      'Other pages of the site linked here:',
      ...page.links.map((link) => `- ${link.label}: ${link.url}`),
    );
  }
  return parts.join('\n').trim();
}

// HTML → readable text, without a DOM: scripts, styles and markup go, block
// elements become line breaks, and the links to the site's own pages are kept.
export function parseHtml(html: string, base: URL, root: URL): WebsitePage {
  const title = text1(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
  const description = text1(
    /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i
      .exec(html)?.[0]
      .match(/\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i)
      ?.slice(2)
      .find((v) => v !== undefined),
  );

  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(
      /<(script|style|noscript|svg|template|iframe|canvas|object|select)\b[\s\S]*?<\/\1\s*>/gi,
      ' ',
    );

  const links: WebsitePage['links'] = [];
  const contacts: string[] = [];
  const seen = new Set<string>([base.toString()]);
  for (const match of body.matchAll(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
    const label = text1(match[4]).slice(0, LINK_LABEL_CHARS);
    if (/^(tel|mailto):/i.test(href)) {
      const contact = href.replace(/\?.*$/, '');
      if (!contacts.includes(contact)) contacts.push(contact);
      continue;
    }
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    url.hash = '';
    const key = url.toString();
    if (!onSite(url, root) || NOT_A_PAGE.test(url.pathname) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (links.length < MAX_LINKS) {
      links.push({ label: label || url.pathname, url: key });
    }
  }

  body = body
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(
      /<\/?(p|div|section|article|header|footer|nav|main|aside|ul|ol|li|h[1-6]|tr|table|thead|tbody|br|hr|form|blockquote|dl|dd|dt|figure|figcaption|address|details|summary|label|button|option)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, ' ');

  return {
    url: base.toString(),
    title,
    description,
    text: tidy(decodeEntities(body)),
    links,
    contacts: contacts.slice(0, 10),
  };
}

// One line of text from a fragment of HTML.
function text1(fragment: string | undefined) {
  return decodeEntities((fragment ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Trimmed lines with runs of spaces folded. Every block is its own line
// already, so blank lines are dropped, and so is a line repeating the one
// before it (menus repeat on many sites).
function tidy(text: string) {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[ \t\f\v\u00a0]+/g, ' ').trim();
    if (!line || line === '-' || line === '|') continue;
    if (lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  times: '×',
  deg: '°',
  laquo: '«',
  raquo: '»',
};

export function decodeEntities(text: string) {
  return text.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (whole, entity: string) => {
      if (entity[0] === '#') {
        const code =
          entity[1].toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    },
  );
}

function redacted(url: URL) {
  const copy = new URL(url);
  copy.search = '';
  return copy.toString();
}

// For tests: forget every page read.
export function clearWebsiteCache() {
  cache.clear();
}
