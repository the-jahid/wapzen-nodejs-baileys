import { extname } from 'node:path';
import mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';
import { MAX_SOURCE_TEXT_LENGTH } from './knowledge-bases.types';

// Reads the text out of an uploaded file, ported from the Go server's
// internal/knowledgebases/extract.go. Extraction is the server's job so the
// indexed text is what this server read, not what a client claimed.

// A file the caller has to fix (wrong format, no text, too long). The
// controller reports it as a field error naming the file, not as a 500.
export class ExtractionError extends Error {}

type Extractor = (data: Buffer) => Promise<string> | string;

// Routed on the extension: the browser's content type isn't reliable, and
// several of these formats share one.
const EXTRACTORS: Record<string, Extractor> = {
  '.txt': plainText,
  '.text': plainText,
  '.md': plainText,
  '.markdown': plainText,
  '.rst': plainText,
  '.log': plainText,
  '.csv': plainText,
  '.tsv': plainText,
  '.json': plainText,
  '.yaml': plainText,
  '.yml': plainText,
  '.xml': plainText,
  '.html': html,
  '.htm': html,
  '.docx': docx,
  '.pdf': pdf,
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXTRACTORS).sort();

// The normalized text of an uploaded file, or an ExtractionError.
export async function extractText(
  filename: string,
  data: Buffer,
): Promise<string> {
  const extension = extname(filename.trim()).toLowerCase();
  const extract = EXTRACTORS[extension];
  if (!extract) {
    // .doc is a different binary format, not an older .docx.
    if (extension === '.doc') {
      throw unsupported(
        'legacy .doc files cannot be read; save the document as .docx or .pdf',
      );
    }
    if (!extension) {
      throw unsupported(
        'the file has no extension, so its format cannot be determined',
      );
    }
    throw unsupported(
      `${extension} (supported: ${SUPPORTED_EXTENSIONS.join(', ')})`,
    );
  }

  const text = normalize(await extract(data));
  if (!text)
    throw new ExtractionError('no text could be extracted from this file');
  const length = [...text].length;
  // Refused rather than truncated: a cut-off document would make the
  // knowledge base claim content it doesn't hold.
  if (length > MAX_SOURCE_TEXT_LENGTH) {
    throw new ExtractionError(
      `extracted text is too long: ${length} characters, at most ${MAX_SOURCE_TEXT_LENGTH} are indexed per source`,
    );
  }
  return text;
}

// Text files may carry a UTF-8 or UTF-16 byte order mark. Invalid UTF-8 or a
// NUL byte means a binary file renamed to .txt.
function plainText(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(data.subarray(2));
  }
  if (data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(data.subarray(2));
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (!text.includes('\0')) return text;
  } catch {
    // fall through
  }
  throw unsupported('the file is not valid UTF-8 text');
}

// A stripper, not a parser: code and comments dropped, block tags turned into
// line breaks so paragraphs don't weld together, other tags removed.
function html(data: Buffer): string {
  return decodeEntities(
    plainText(data)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/\s*script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/\s*style\s*>/gi, ' ')
      .replace(
        /<\s*\/?\s*(br|p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|blockquote|pre)\b[^>]*>/gi,
        '\n',
      )
      .replace(/<[^>]*>/g, ' '),
  );
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity: string, name: string) => {
      if (name[0] === '#') {
        const code =
          name[1].toLowerCase() === 'x'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : entity;
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    },
  );
}

async function docx(data: Buffer): Promise<string> {
  try {
    return (await mammoth.extractRawText({ buffer: data })).value;
  } catch {
    throw unsupported('the file is not a readable .docx document');
  }
}

// A scanned PDF has no text layer and comes back empty, which extractText
// reports as "no text could be extracted".
async function pdf(data: Buffer): Promise<string> {
  try {
    const { text } = await extractPdfText(new Uint8Array(data), {
      mergePages: true,
    });
    return text;
  } catch (err) {
    throw unsupported(`the PDF could not be read (${(err as Error).message})`);
  }
}

// \n line endings, no control or zero-width characters, non-breaking spaces as
// spaces, no trailing spaces, at most one blank line in a row. The blank-line
// rule matters: the chunker splits on blank lines, and an export with several
// between every line would otherwise become one chunk per line.
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\ufeff|\u200b|\u200c|\u200d|\ufffd/g, '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .split('')
    .filter((ch) => ch === '\n' || ch === '\t' || !isControl(ch))
    .join('')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// C0 and C1 control codes carry nothing to retrieve.
function isControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function unsupported(detail: string) {
  return new ExtractionError(`unsupported file type: ${detail}`);
}
