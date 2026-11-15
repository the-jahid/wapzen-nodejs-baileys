import { EventEmitter } from 'node:events';
import type { BinaryNode, WASocket } from 'baileys';
import { ackStatusPostsPlainly } from './status-ack';

// Baileys is ESM-only, which Jest can't load. These two mirror Baileys' own
// (jid-utils isJidStatusBroadcast, stanza-ack buildAckStanza for a message).
jest.mock('baileys', () => ({
  __esModule: true,
  isJidStatusBroadcast: (jid: string) => jid === 'status@broadcast',
  buildAckStanza: (
    node: { tag: string; attrs: Record<string, string> },
    errorCode?: number,
    meId?: string,
  ) => {
    const attrs: Record<string, string> = {
      id: node.attrs.id,
      to: node.attrs.from,
      class: node.tag,
    };
    if (errorCode) attrs.error = String(errorCode);
    if (node.attrs.participant) attrs.participant = node.attrs.participant;
    if (node.attrs.type) attrs.type = node.attrs.type;
    if (node.tag === 'message' && meId) attrs.from = meId;
    return { tag: 'ack', attrs };
  },
}));

function setup(sendFails = false) {
  const ws = new EventEmitter();
  const sent: BinaryNode[] = [];
  const errors: Error[] = [];
  const sock = {
    ws,
    authState: { creds: { me: { id: '8801700000000:5@s.whatsapp.net' } } },
    sendNode: (node: BinaryNode) => {
      sent.push(node);
      return sendFails
        ? Promise.reject(new Error('Connection Closed'))
        : Promise.resolve();
    },
  } as unknown as WASocket;
  ackStatusPostsPlainly(sock, (err) => errors.push(err));
  const seen: BinaryNode[] = [];
  ws.on('CB:message', (node: BinaryNode) => seen.push(node));
  return { ws, sent, seen, errors };
}

const statusPost: BinaryNode = {
  tag: 'message',
  attrs: {
    from: 'status@broadcast',
    id: 'AC7F269CABD669B3248C7B575171B38A',
    participant: '8801811111111@s.whatsapp.net',
    type: 'media',
  },
};

describe('ackStatusPostsPlainly', () => {
  it('acks a status post without an error code and keeps it from Baileys', () => {
    const { ws, sent, seen } = setup();
    expect(ws.emit('CB:message', statusPost)).toBe(true);
    expect(seen).toEqual([]);
    expect(sent).toEqual([
      {
        tag: 'ack',
        attrs: {
          id: 'AC7F269CABD669B3248C7B575171B38A',
          to: 'status@broadcast',
          class: 'message',
          participant: '8801811111111@s.whatsapp.net',
          type: 'media',
          from: '8801700000000:5@s.whatsapp.net',
        },
      },
    ]);
    expect(sent[0].attrs.error).toBeUndefined();
  });

  it('passes every other message through untouched', () => {
    const { ws, sent, seen } = setup();
    const chat: BinaryNode = {
      tag: 'message',
      attrs: { from: '8801811111111@s.whatsapp.net', id: 'X1', type: 'text' },
    };
    const group: BinaryNode = {
      tag: 'message',
      attrs: { from: '120363000000000000@g.us', id: 'X2', type: 'text' },
    };
    ws.emit('CB:message', chat);
    ws.emit('CB:message', group);
    expect(seen).toEqual([chat, group]);
    expect(sent).toEqual([]);
  });

  it('leaves receipts and other events from status@broadcast alone', () => {
    const { ws, sent } = setup();
    const receipts: BinaryNode[] = [];
    ws.on('CB:receipt', (node: BinaryNode) => receipts.push(node));
    const receipt = { ...statusPost, tag: 'receipt' };
    ws.emit('CB:receipt', receipt);
    expect(receipts).toEqual([receipt]);
    expect(sent).toEqual([]);
  });

  it('reports a failed send instead of throwing', async () => {
    const { ws, errors } = setup(true);
    expect(() => ws.emit('CB:message', statusPost)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors.map((e) => e.message)).toEqual(['Connection Closed']);
  });

  it('does nothing to a socket without a websocket', () => {
    expect(() =>
      ackStatusPostsPlainly({} as unknown as WASocket),
    ).not.toThrow();
  });
});
