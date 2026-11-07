// Voice messages and photos people send. WhatsApp hands over only a pointer;
// the file is fetched (and decrypted) only once the agent on the number has
// the matching switch on, so a number that doesn't use them never downloads.
export type IncomingMedia = {
  kind: 'voice' | 'image';
  mimetype: string;
  // Size and length as the message states them, checked before downloading.
  bytes: number;
  seconds: number;
  download: () => Promise<Buffer>;
};

// OpenAI's newest transcription model. Measured 2026-11-03 on Ogg/Opus voice
// notes (WhatsApp's format): word for word in English and Bangla, 0.8–1s for
// 6–8s of speech, a little faster than gpt-4o(-mini)-transcribe.
const TRANSCRIBE_MODEL = 'gpt-transcribe';
const TRANSCRIBE_TIMEOUT_MS = 30_000;
// A longer voice message isn't answered: it would hold the chat on "typing"
// and cost far more than a reply is worth. OpenAI refuses audio over 25 MB
// and images over 20 MB.
export const MAX_VOICE_SECONDS = 5 * 60;
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// The formats the model takes. WhatsApp photos are JPEG.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// OpenAI tells the audio format from the file name, so the name has to match.
const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

// The words of a voice message, in the language it was spoken in.
export async function transcribe(
  apiKey: string,
  audio: Buffer,
  mimetype: string,
): Promise<string> {
  const type = baseType(mimetype) || 'audio/ogg';
  const form = new FormData();
  form.append('model', TRANSCRIBE_MODEL);
  form.append(
    'file',
    new Blob([new Uint8Array(audio)], { type }),
    `voice.${AUDIO_EXTENSIONS[type] ?? 'ogg'}`,
  );
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const { text } = (await res.json()) as { text?: string };
  return text?.trim() ?? '';
}

// A photo over this size is usually an HD one. OpenAI's vision models have scaled
// images to fit this many pixels before reading them, so this keeps that detail.
const SHRINK_PHOTOS_OVER_BYTES = 500 * 1024;
const MODEL_IMAGE_SIDE = 2048;

// A large JPEG resized to what the model will read, so a few megabytes don't go
// up for nothing. Anything else, or any trouble resizing, keeps the original.
export async function smallerPhoto(image: Buffer, mimetype: string) {
  if (image.length <= SHRINK_PHOTOS_OVER_BYTES) return image;
  if (baseType(mimetype) !== 'image/jpeg') return image;
  try {
    const { default: sharp } = await import('sharp');
    const smaller = await sharp(image)
      .rotate()
      .resize({
        width: MODEL_IMAGE_SIDE,
        height: MODEL_IMAGE_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    return smaller.length < image.length ? smaller : image;
  } catch {
    return image;
  }
}

// A photo as the data URL the model reads, or undefined for a format it
// doesn't take.
export function imageDataUrl(image: Buffer, mimetype: string) {
  const type = baseType(mimetype) || 'image/jpeg';
  if (!IMAGE_TYPES.includes(type)) return undefined;
  return `data:${type};base64,${image.toString('base64')}`;
}

// "audio/ogg; codecs=opus" → "audio/ogg".
function baseType(mimetype: string) {
  return mimetype.split(';')[0].trim().toLowerCase();
}
