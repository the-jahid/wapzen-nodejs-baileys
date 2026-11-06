// What an owner can upload for an agent to send: images and documents, no video.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_AGENT = 20;
export const MAX_DESCRIPTION_CHARS = 300;
const MAX_NAME_CHARS = 200;

// The file without its bytes: what the dashboard lists and the agent reads.
export type AgentFile = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  description: string;
  created_at: string;
};

// A file on its way to a customer.
export type OutgoingFile = {
  fileName: string;
  mimeType: string;
  data: Buffer;
};

const startsWith = (data: Buffer, ...bytes: number[]) =>
  bytes.every((byte, i) => data[i] === byte);
const isJpeg = (d: Buffer) => startsWith(d, 0xff, 0xd8, 0xff);
const isPng = (d: Buffer) => startsWith(d, 0x89, 0x50, 0x4e, 0x47);
const isWebp = (d: Buffer) =>
  d.subarray(0, 4).toString('latin1') === 'RIFF' &&
  d.subarray(8, 12).toString('latin1') === 'WEBP';
const isPdf = (d: Buffer) => d.subarray(0, 5).toString('latin1') === '%PDF-';
// .docx, .xlsx and .pptx are zip files; .doc, .xls and .ppt are OLE files.
const isZip = (d: Buffer) => startsWith(d, 0x50, 0x4b, 0x03, 0x04);
const isOle = (d: Buffer) => startsWith(d, 0xd0, 0xcf, 0x11, 0xe0);
const isText = (d: Buffer) => !d.subarray(0, 8192).includes(0);

// The type goes to WhatsApp and on to the customer's phone, so it comes from
// here and the file's own first bytes have to agree: not from what the browser
// said, and not from the name alone.
const FILE_TYPES: Record<
  string,
  { mime: string; matches: (data: Buffer) => boolean }
> = {
  jpg: { mime: 'image/jpeg', matches: isJpeg },
  jpeg: { mime: 'image/jpeg', matches: isJpeg },
  png: { mime: 'image/png', matches: isPng },
  webp: { mime: 'image/webp', matches: isWebp },
  pdf: { mime: 'application/pdf', matches: isPdf },
  doc: { mime: 'application/msword', matches: isOle },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    matches: isZip,
  },
  xls: { mime: 'application/vnd.ms-excel', matches: isOle },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    matches: isZip,
  },
  ppt: { mime: 'application/vnd.ms-powerpoint', matches: isOle },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    matches: isZip,
  },
  txt: { mime: 'text/plain', matches: isText },
  csv: { mime: 'text/csv', matches: isText },
};

export const ALLOWED_EXTENSIONS = Object.keys(FILE_TYPES);

// The type to store a file as, or undefined when it isn't one we take.
export function detectMimeType(fileName: string, data: Buffer) {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  const type = Object.hasOwn(FILE_TYPES, extension)
    ? FILE_TYPES[extension]
    : undefined;
  return data.length && type?.matches(data) ? type.mime : undefined;
}

// WhatsApp shows JPEG and PNG as photos. Anything else, WebP included, goes as
// a document, which every phone can open.
export const sendsAsPhoto = (mimeType: string) =>
  mimeType === 'image/jpeg' || mimeType === 'image/png';

// The name the customer sees: no folders, no control characters.
export function cleanFileName(raw: string) {
  const name = raw
    .split(/[/\\]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return Array.from(name).slice(-MAX_NAME_CHARS).join('');
}
