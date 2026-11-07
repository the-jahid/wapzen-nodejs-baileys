import type { OutgoingFile } from '../agent-files/agent-files.types';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatResponderService } from './chat-responder.service';
import { WhatsAppService } from './whatsapp.service';

// How a file gets to WhatsApp: uploaded once, then sent from that upload for a
// while. The socket is a fake here, since Baileys is ESM-only and Jest can't load
// it; the same steps were also run against the real Baileys by hand.

jest.mock('baileys', () => ({
  __esModule: true,
  default: () => undefined,
  Browsers: { macOS: () => ['Mac OS', 'Chrome', '1'] },
  DisconnectReason: {},
  generateMessageIDV2: () => 'NEW-ID',
  generateWAMessageFromContent: (
    jid: string,
    message: unknown,
    { messageId }: { messageId: string },
  ) => ({ key: { remoteJid: jid, id: messageId }, message }),
  proto: {
    Message: {
      encode: (message: unknown) => ({
        finish: () => Buffer.from(JSON.stringify(message)),
      }),
      decode: (bytes: Uint8Array) =>
        JSON.parse(Buffer.from(bytes).toString()) as unknown,
    },
  },
}));
jest.mock('./auth-state', () => ({ usePrismaAuthState: jest.fn() }));
jest.mock('./chat-responder.service', () => ({
  ChatResponderService: class {},
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

const BYTES = Buffer.from('%PDF-1.7');
const UPLOADED = { url: 'https://mmg.whatsapp.net/d/f/abc', mediaKey: 'key' };
const FIRST_SECRET = 'the first message secret';
const HOUR = 60 * 60_000;
const anySecret = {
  messageContextInfo: { messageSecret: expect.any(Buffer) as Buffer },
};

function setup() {
  const service = new WhatsAppService(
    {} as PrismaService,
    {} as ChatResponderService,
  ) as unknown as {
    sendFileFrom(
      id: string,
      sock: unknown,
      jid: string,
      file: OutgoingFile,
    ): Promise<unknown>;
  };
  const sock = {
    user: { id: '8801700000000:5@s.whatsapp.net' },
    // The real one uploads the file and returns the message it sent.
    sendMessage: jest.fn((_jid: string, content: Record<string, unknown>) =>
      Promise.resolve({
        message: {
          ...(content.image
            ? { imageMessage: UPLOADED }
            : { documentMessage: { ...UPLOADED, fileName: content.fileName } }),
          messageContextInfo: { messageSecret: FIRST_SECRET },
        },
      }),
    ),
    relayMessage: jest.fn<Promise<string>, [string, unknown, unknown]>(() =>
      Promise.resolve('NEW-ID'),
    ),
  };
  const load = jest.fn(() => Promise.resolve(BYTES));
  const pdf: OutgoingFile = {
    id: 'file-1',
    fileName: 'menu.pdf',
    mimeType: 'application/pdf',
    load,
  };
  const send = (to: string, file = pdf, number = 'number-1') =>
    service.sendFileFrom(number, sock, to, file);
  return { sock, load, pdf, send };
}

describe('sending an agent file', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uploads it the first time, as a document with its name', async () => {
    const { sock, load, send } = setup();
    await send('111@lid');
    expect(load).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage).toHaveBeenCalledWith('111@lid', {
      document: BYTES,
      mimetype: 'application/pdf',
      fileName: 'menu.pdf',
    });
    expect(sock.relayMessage).not.toHaveBeenCalled();
  });

  it('sends a JPEG as a photo', async () => {
    const { sock, load, send } = setup();
    const photo: OutgoingFile = {
      id: 'file-2',
      fileName: 'shop.jpg',
      mimeType: 'image/jpeg',
      load,
    };
    await send('111@lid', photo);
    expect(sock.sendMessage).toHaveBeenCalledWith('111@lid', {
      image: BYTES,
      mimetype: 'image/jpeg',
    });
    await send('222@lid', photo);
    expect(sock.relayMessage).toHaveBeenCalledWith(
      '222@lid',
      { imageMessage: UPLOADED, ...anySecret },
      { messageId: 'NEW-ID' },
    );
  });

  it('neither reads nor uploads it again for the next person', async () => {
    const { sock, load, send } = setup();
    await send('111@lid');
    await send('222@lid');
    await send('333@lid');

    expect(load).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    expect(sock.relayMessage).toHaveBeenCalledTimes(2);
    expect(sock.relayMessage).toHaveBeenLastCalledWith(
      '333@lid',
      { documentMessage: { ...UPLOADED, fileName: 'menu.pdf' }, ...anySecret },
      { messageId: 'NEW-ID' },
    );
  });

  it('gives every message a secret of its own', async () => {
    const { sock, send } = setup();
    await send('111@lid');
    await send('222@lid');
    await send('333@lid');
    const secrets = sock.relayMessage.mock.calls.map(
      ([, message]) =>
        (message as { messageContextInfo: { messageSecret: Buffer } })
          .messageContextInfo.messageSecret,
    );
    expect(secrets[0]).toHaveLength(32);
    expect(secrets[1]).toHaveLength(32);
    expect(secrets[0].equals(secrets[1])).toBe(false);
    expect(String(secrets[0])).not.toContain(FIRST_SECRET);
  });

  it('uploads it afresh once the upload is six hours old', async () => {
    const { sock, load, send } = setup();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000);
    await send('111@lid');
    now.mockReturnValue(1_000_000_000 + 6 * HOUR - 1);
    await send('222@lid');
    expect(sock.relayMessage).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000_000 + 6 * HOUR);
    await send('333@lid');
    expect(load).toHaveBeenCalledTimes(2);
    expect(sock.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps each file and each number apart', async () => {
    const { sock, load, pdf, send } = setup();
    await send('111@lid');
    await send('111@lid', { ...pdf, id: 'file-2' });
    await send('111@lid', pdf, 'number-2');
    expect(load).toHaveBeenCalledTimes(3);
    expect(sock.relayMessage).not.toHaveBeenCalled();
  });

  it('reports a failed send, and uploads again on the next try', async () => {
    const { sock, load, send } = setup();
    await send('111@lid');
    sock.relayMessage.mockRejectedValueOnce(new Error('offline'));
    await expect(send('222@lid')).rejects.toThrow('offline');

    await send('222@lid');
    expect(load).toHaveBeenCalledTimes(2);
    expect(sock.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('remembers nothing when the first upload fails', async () => {
    const { sock, load, send } = setup();
    sock.sendMessage.mockRejectedValueOnce(new Error('offline'));
    await expect(send('111@lid')).rejects.toThrow('offline');

    await send('111@lid');
    expect(load).toHaveBeenCalledTimes(2);
    expect(sock.relayMessage).not.toHaveBeenCalled();
  });

  it('reports a file that is gone from the database', async () => {
    const { sock, load, send } = setup();
    load.mockRejectedValueOnce(new Error('file file-1 is gone'));
    await expect(send('111@lid')).rejects.toThrow('gone');
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });
});
