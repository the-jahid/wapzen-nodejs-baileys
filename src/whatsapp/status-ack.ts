import {
  BinaryNode,
  buildAckStanza,
  isJidStatusBroadcast,
  WASocket,
} from 'baileys';

// WhatsApp Status posts (contacts' stories) are never answered, so they are not
// decrypted. Left to shouldIgnoreJid, Baileys acks each one with error 500
// ("UnhandledError"), as if this device had failed to read it. Prod logs on
// 2026-11-15 showed WhatsApp ending sockets with a stream:error naming a status
// post (`<ack class="status" type="media|text" id=...>`), several numbers a
// minute, and every one of those costs a full reconnect. This answers status
// posts with the plain ack a client that read them sends, before Baileys sees
// them, and still without decrypting anything.
//
// Baileys emits each incoming stanza on its websocket as `CB:message` (plus
// narrower variants nobody listens to for messages), so wrapping emit is the
// one place to take the stanza before its nack path runs.
export function ackStatusPostsPlainly(
  sock: Pick<WASocket, 'ws' | 'sendNode' | 'authState'>,
  onError?: (err: Error) => void,
): void {
  const ws = sock.ws as unknown as
    | { emit: (event: string | symbol, ...args: unknown[]) => boolean }
    | undefined;
  if (typeof ws?.emit !== 'function') return;
  const emit = ws.emit.bind(ws);
  ws.emit = (event, ...args) => {
    if (event === 'CB:message') {
      const node = args[0] as BinaryNode | undefined;
      if (isJidStatusBroadcast(node?.attrs?.from ?? '')) {
        const ack = buildAckStanza(
          node!,
          undefined,
          sock.authState.creds.me?.id,
        );
        sock.sendNode(ack).catch((err: Error) => onError?.(err));
        return true;
      }
    }
    return emit(event, ...args);
  };
}
