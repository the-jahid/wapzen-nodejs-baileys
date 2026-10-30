// Splits a source's text into the pieces that get embedded, ported from the
// Go server's internal/knowledgebases/chunk.go so both servers chunk the same
// text the same way.
//
// Sizes are in characters (code points, like Go's runes). The split prefers
// the largest boundary that fits: whole paragraphs, then sentences, then
// words; only a single word longer than max is cut mid-word. min is applied
// afterwards by merging a short chunk into its neighbour, since a tiny chunk
// carries too little context to retrieve well. The last chunk can still be
// below min when the whole source is.
export function chunkText(
  text: string,
  minChunkSize: number,
  maxChunkSize: number,
): string[] {
  text = text.trim();
  if (!text) return [];
  if (maxChunkSize <= 0) return [text];
  if (minChunkSize > maxChunkSize) minChunkSize = maxChunkSize;

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = '';
  };

  // Appends one indivisible piece, starting a new chunk when it doesn't fit.
  const add = (piece: string, separator: string) => {
    if (!current) {
      current = piece;
    } else if (len(current) + len(separator) + len(piece) <= maxChunkSize) {
      current += separator + piece;
    } else {
      flush();
      current = piece;
    }
  };

  for (const paragraph of splitParagraphs(text)) {
    if (len(paragraph) <= maxChunkSize) {
      add(paragraph, '\n\n');
      continue;
    }
    for (const sentence of splitSentences(paragraph)) {
      if (len(sentence) <= maxChunkSize) {
        add(sentence, ' ');
        continue;
      }
      for (const piece of splitLongText(sentence, maxChunkSize)) {
        add(piece, ' ');
      }
    }
  }
  flush();

  return mergeShortChunks(chunks, minChunkSize, maxChunkSize);
}

// Blank lines are the strongest boundary plain text carries.
function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .map((part) => part.trim())
    .filter(Boolean);
}

// Breaks after . ! ? or a newline, but only when whitespace or the end
// follows, so "3.5" and "e.g." stay whole. Deliberately naive: a wrong split
// only costs one odd chunk boundary.
function splitSentences(paragraph: string): string[] {
  const out: string[] = [];
  const chars = [...paragraph];
  let sentence = '';
  chars.forEach((ch, i) => {
    sentence += ch;
    if (!'.!?\n'.includes(ch)) return;
    if (i + 1 < chars.length && !/\s/.test(chars[i + 1])) return;
    if (sentence.trim()) out.push(sentence.trim());
    sentence = '';
  });
  if (sentence.trim()) out.push(sentence.trim());
  return out;
}

// Cuts text with no usable sentence boundary into max-sized pieces, between
// words where possible.
function splitLongText(text: string, maxChunkSize: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!current) {
      current = word;
    } else if (len(current) + 1 + len(word) <= maxChunkSize) {
      current += ' ' + word;
    } else {
      out.push(current);
      current = word;
    }
    // A single word longer than the limit has no boundary left to prefer.
    while (len(current) > maxChunkSize) {
      const chars = [...current];
      out.push(chars.slice(0, maxChunkSize).join(''));
      current = chars.slice(maxChunkSize).join('');
    }
  }
  if (current) out.push(current);
  return out;
}

// Folds a chunk below min into its neighbour when the result still fits. One
// with no neighbour it fits with is kept: dropping it would lose the text.
function mergeShortChunks(
  chunks: string[],
  minChunkSize: number,
  maxChunkSize: number,
): string[] {
  if (chunks.length < 2 || minChunkSize <= 0) return chunks;
  const out: string[] = [];
  for (const chunk of chunks) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      (len(previous) < minChunkSize || len(chunk) < minChunkSize) &&
      len(previous) + 1 + len(chunk) <= maxChunkSize
    ) {
      out[out.length - 1] = previous + '\n' + chunk;
      continue;
    }
    out.push(chunk);
  }
  return out;
}

function len(s: string): number {
  return [...s].length;
}
