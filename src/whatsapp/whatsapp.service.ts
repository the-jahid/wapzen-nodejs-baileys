import {
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import makeWASocket, {
  AuthenticationState,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isPnUser,
  jidDecode,
  makeCacheableSignalKeyStore,
  proto,
  S_WHATSAPP_NET,
  WAMessage,
  WASocket,
  WAVersion,
} from 'baileys';
import pino from 'pino';
import { activity } from '../activity/activity';
import { apiError } from '../chat-agents/chat-agents.types';
import { PrismaService } from '../prisma/prisma.service';
import { usePrismaAuthState } from './auth-state';
import { ChatResponderService } from './chat-responder.service';
import {
  LoginRequest,
  LoginState,
  PhoneNumberResource,
  toResource,
} from './phone-number.types';

type ConnectOptions = {
  pairWith?: string; // digits only, no '+'
  onCode?: () => void;
  onError?: (err: Error) => void;
  // Called once the socket has opened or closed, whichever comes first.
  onSettled?: () => void;
};

const FIRST_CODE_TIMEOUT_MS = 30_000;
// A dropped number retries after 5s, doubling while it keeps failing.
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
// After a restart linked numbers reopen a few at a time: on one CPU, fifty
// handshakes and offline backlogs at once starve the keepalives and WhatsApp
// drops the sockets again. A number that takes longer stops holding its slot.
const RESUME_CONCURRENCY = 5;
const RESUME_SLOT_MS = 30_000;
// Baileys' own log output, off unless VERBOSE_LOGS=true.
const BAILEYS_LOG_LEVEL =
  process.env.VERBOSE_LOGS === 'true' ? 'error' : 'silent';
const VERSION_TTL_MS = 60 * 60_000;
// How long an unlink may wait for WhatsApp, connecting included.
const UNLINK_TIMEOUT_MS = 20_000;
// Close codes meaning WhatsApp no longer accepts a device's keys at all.
const KEYS_REFUSED = new Set<number>([
  DisconnectReason.badSession,
  DisconnectReason.forbidden,
  DisconnectReason.multideviceMismatch,
]);
// Messages that waited longer than this (delivered on reconnect) get no reply:
// the person has long stopped waiting, and answering a backlog looks broken.
const STALE_MESSAGE_SECONDS = 5 * 60;
// LID<->phone mappings kept in memory per number (two per contact). Baileys'
// own cache keeps every one for 7 days with no cap, ~1 KB a contact, and the
// history sync at link time loads the whole address book into it: megabytes
// per business number, the largest thing a number holds. Every mapping is
// also in whatsapp_auth, so one dropped here costs a database read.
const LID_CACHE_SIZE = 1_000;

export class NumberNotConnectedError extends Error {
  constructor() {
    super('phone number is not connected');
  }
}

// One WhatsApp linked device per phone_numbers row, kept open with Baileys.
//
// A login works the way the dashboard expects from the Go server: asking for
// a QR code creates a pending row that isn't listed as a phone number until a
// phone scans it, the row disappears if nobody does (so polling it 404s and
// the dashboard asks for a fresh one), and a QR login already running is
// handed back instead of opening a second one.
@Injectable()
export class WhatsAppService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly baileysLogger = pino({ level: BAILEYS_LOG_LEVEL });
  private readonly sockets = new Map<string, WASocket>();
  // Reconnects in a row that failed, by row id; cleared once one opens.
  private readonly failures = new Map<string, number>();
  // Logins still waiting for the phone, by row id.
  private readonly logins = new Map<string, LoginState>();
  // A login that linked a number the account already had moves onto that
  // number's row; the dashboard keeps polling the login's id, so it's mapped.
  private readonly relinked = new Map<string, string>();
  private shuttingDown = false;
  private version?: { value: WAVersion; at: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly responder: ChatResponderService,
  ) {}

  // Linked numbers go dead after a restart unless their sockets are reopened.
  // Runs in the background so a database problem doesn't stop the server.
  onApplicationBootstrap() {
    this.resumeSessions().catch((err: Error) =>
      this.logger.error(`resuming phone numbers failed: ${err.message}`),
    );
  }

  private async resumeSessions() {
    // A login can't survive a restart. One that never linked is dropped; a
    // linked number that was mid re-pair has no keys left and stays offline
    // until someone pairs it again.
    const unlinked = await this.prisma.phoneNumber.findMany({
      where: { status: 'pending_qr', waJid: null },
      select: { id: true },
    });
    for (const { id } of unlinked) await this.deleteRow(id);
    await this.prisma.phoneNumber.updateMany({
      where: { status: 'pending_qr' },
      data: { status: 'disconnected', qrCode: null },
    });

    const linked = await this.prisma.phoneNumber.findMany({
      where: { waJid: { not: null }, authValues: { some: { key: 'creds' } } },
      select: { id: true },
    });
    let next = 0;
    const worker = async () => {
      while (!this.shuttingDown && next < linked.length) {
        await this.connectAndWait(linked[next++].id);
      }
    };
    await Promise.all(Array.from({ length: RESUME_CONCURRENCY }, worker));
  }

  // Opens a linked number and resolves once it has opened or closed, or
  // after RESUME_SLOT_MS.
  private connectAndWait(id: string) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RESUME_SLOT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.connect(id, { onSettled: done }).catch((err: Error) => {
        this.logger.error(`resume ${id} failed: ${err.message}`);
        done();
      });
    });
  }

  onModuleDestroy() {
    this.shuttingDown = true;
    // A login can't survive a restart, so its user has to start again.
    for (const id of [...this.logins.keys()]) {
      this.endLogin(id, 'failed', 'the server restarted');
    }
    for (const sock of this.sockets.values()) void sock.end(undefined);
  }

  // The account's numbers. Logins nobody has scanned yet aren't numbers.
  async list(userId: string): Promise<PhoneNumberResource[]> {
    const rows = await this.prisma.phoneNumber.findMany({
      where: { userId, NOT: { status: 'pending_qr', waJid: null } },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map((row) => toResource(row, undefined)));
  }

  async get(userId: string, id: string): Promise<PhoneNumberResource> {
    const row = await this.owned(userId, this.relinked.get(id) ?? id);
    return toResource(row, this.logins.get(row.id));
  }

  // A fresh login on a new row. Resolves once WhatsApp hands out the first QR
  // code (or the pairing code).
  async startLogin(
    userId: string,
    email: string,
    req: LoginRequest,
  ): Promise<PhoneNumberResource> {
    const running = await this.prisma.phoneNumber.findMany({
      where: { userId, status: 'pending_qr', waJid: null },
      orderBy: { createdAt: 'desc' },
    });
    if (req.byCode) {
      // A code login replaces any QR login the user has open.
      for (const row of running) {
        this.endLogin(row.id, 'cancelled', 'switched to a pairing code');
        this.stopSocket(row.id);
        await this.deleteRow(row.id);
      }
    } else {
      const live = running.find(
        (row) => this.sockets.has(row.id) && this.logins.has(row.id),
      );
      if (live) return toResource(live, this.logins.get(live.id));
    }

    const row = await this.prisma.phoneNumber.create({
      data: { userId, label: req.label },
    });
    try {
      await this.openLogin(
        row.id,
        email,
        req.byCode ? req.phoneNumber : undefined,
      );
    } catch (err) {
      this.stopSocket(row.id);
      await this.deleteRow(row.id);
      throw this.loginError(err as Error, req.byCode, email);
    }
    return this.get(userId, row.id);
  }

  // A new QR code for an existing row. forceRepair first unlinks the device
  // that is there now; the row, and the chat agent it's assigned to, stay.
  async restartLogin(
    userId: string,
    id: string,
    forceRepair: boolean,
    email: string,
  ): Promise<PhoneNumberResource> {
    const row = await this.owned(userId, id);
    const sock = this.sockets.get(id);
    if (!forceRepair) {
      if (row.status === 'connected' && sock) {
        throw apiError(
          HttpStatus.CONFLICT,
          'phone number is already connected',
        );
      }
      if (sock && this.logins.has(id)) {
        throw apiError(
          HttpStatus.CONFLICT,
          'phone number login is already in progress',
        );
      }
    }

    if (forceRepair) await this.unlinkOrFail(id, row.waJid);
    else this.stopSocket(id);
    await this.prisma.whatsAppAuth.deleteMany({ where: { phoneNumberId: id } });
    await this.prisma.phoneNumber.update({
      where: { id },
      data: { status: 'pending_qr', qrCode: null },
    });

    try {
      await this.openLogin(id, email);
    } catch (err) {
      this.stopSocket(id);
      this.logins.delete(id);
      await this.prisma.phoneNumber.update({
        where: { id },
        data: { status: 'disconnected', qrCode: null },
      });
      throw this.loginError(err as Error, false, email);
    }
    return this.get(userId, id);
  }

  // Unlinks the device from WhatsApp and deletes the row (and its auth keys).
  // Nothing is deleted until WhatsApp has confirmed the device is gone from
  // the phone's Linked devices: deleting the keys first would leave a device
  // there that nothing can remove any more.
  async logout(userId: string, id: string) {
    const row = await this.owned(userId, id);
    await this.unlinkOrFail(id, row.waJid);
    await this.deleteRow(id);
  }

  // Sends a text on one of the user's numbers, for a person replying from the
  // dashboard. Only a linked number that is online can send.
  async sendText(userId: string, id: string, jid: string, text: string) {
    const sock = this.sockets.get(id);
    const row = await this.prisma.phoneNumber.findFirst({
      where: { id, userId },
      select: { status: true },
    });
    if (!sock || row?.status !== 'connected' || this.logins.has(id)) {
      throw new NumberNotConnectedError();
    }
    await sock.sendMessage(jid, { text });
  }

  // unlink for a request: a WhatsApp that can't be reached is a 502, and the
  // number goes back online so it keeps working until the next try.
  private async unlinkOrFail(id: string, waJid: string | null) {
    try {
      await this.unlink(id, waJid);
    } catch (err) {
      this.logger.warn(`unlink ${id} failed: ${(err as Error).message}`);
      if (!this.sockets.has(id)) {
        this.connect(id).catch((e: Error) =>
          this.logger.error(`reconnect ${id} failed: ${e.message}`),
        );
      }
      throw apiError(
        HttpStatus.BAD_GATEWAY,
        "Couldn't reach WhatsApp to unlink this number from Linked devices. Nothing was removed; try again in a moment.",
      );
    }
  }

  // Removes this server's device from the phone's WhatsApp > Linked devices
  // and waits for WhatsApp to confirm it (Baileys' own logout() sends the
  // request without waiting, and silently does nothing on a closed socket).
  // Uses the open socket when there is one, else a short-lived one opened
  // with the stored keys. A number that never linked, or a login whose keys
  // were already reset, has nothing to unlink.
  private async unlink(id: string, waJid: string | null) {
    const sock = this.sockets.get(id);
    this.sockets.delete(id);
    const login = this.logins.get(id);
    this.endLogin(id, 'cancelled');
    if (!waJid || login) {
      void sock?.end(undefined);
      return;
    }

    if (sock?.user) {
      try {
        await removeDevice(sock, waJid);
        this.logger.log(`${id} unlinked from WhatsApp`);
        return;
      } catch (err) {
        this.logger.warn(
          `unlink ${id} on the open socket failed: ${(err as Error).message}`,
        );
      } finally {
        void sock.end(undefined);
      }
    } else {
      void sock?.end(undefined);
    }
    await this.unlinkWithFreshSocket(id, waJid);
  }

  private async unlinkWithFreshSocket(id: string, waJid: string) {
    const [{ state }, version] = await Promise.all([
      usePrismaAuthState(this.prisma, id),
      this.waVersion(),
    ]);
    if (!state.creds.me) return;
    const sock = this.makeSocket(state, version);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void sock.end(undefined);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error('WhatsApp did not answer in time')),
        UNLINK_TIMEOUT_MS,
      );
      sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
          removeDevice(sock, waJid).then(() => {
            this.logger.log(`${id} unlinked from WhatsApp`);
            finish();
          }, finish);
        }
        if (connection !== 'close') return;
        const code = closeCode(lastDisconnect?.error);
        if (code === DisconnectReason.loggedOut) {
          // Already removed on the phone.
          finish();
        } else if (code !== undefined && KEYS_REFUSED.has(code)) {
          // WhatsApp won't take these keys any more, so this server can't
          // unlink with them; retrying wouldn't change that.
          this.logger.warn(
            `${id}: WhatsApp refused its keys (${code}); if the phone still lists the device, remove it there`,
          );
          finish();
        } else {
          finish(new Error(`connection closed (${code ?? 'no code'})`));
        }
      });
    });
  }

  private async owned(userId: string, id: string) {
    const row = await this.prisma.phoneNumber.findFirst({
      where: { id, userId },
    });
    if (!row) throw apiError(HttpStatus.NOT_FOUND, 'phone number not found');
    return row;
  }

  // Opens a socket for a login and waits for its first QR or pairing code.
  private async openLogin(id: string, email: string, phoneNumber?: string) {
    const login: LoginState = {
      email,
      byCode: !!phoneNumber,
      startedAt: Date.now(),
      qrCount: 0,
    };
    this.logins.set(id, login);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('WhatsApp did not return a login code in time')),
        FIRST_CODE_TIMEOUT_MS,
      );
      const settle = (err?: Error) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      this.connect(id, {
        pairWith: phoneNumber?.slice(1),
        onCode: () => settle(),
        onError: settle,
      }).catch(settle);
    });
    login.codeShown = true;
    reportLogin(login, 'started');
  }

  // Forgets a login and reports how it ended. One that never got as far as
  // showing a code is reported by loginError instead.
  private endLogin(id: string, outcome: string, detail?: string) {
    const login = this.logins.get(id);
    this.logins.delete(id);
    if (login?.codeShown) reportLogin(login, outcome, detail);
  }

  private loginError(err: Error, byCode: boolean, email: string) {
    this.logger.warn(`login failed: ${err.message}`);
    reportLogin({ email, byCode }, 'failed', err.message);
    if (byCode) {
      return apiError(
        HttpStatus.BAD_REQUEST,
        'WhatsApp could not create a code for this number. Check it includes the country code and is the number WhatsApp is on.',
      );
    }
    return apiError(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'failed to start phone number login',
    );
  }

  // The current WhatsApp Web version (a stale one gets the socket refused).
  // Fetched at most once an hour rather than on every connect: WhatsApp's
  // forced reconnect right after a scan used to wait on it again.
  private async waVersion() {
    if (this.version && Date.now() - this.version.at < VERSION_TTL_MS) {
      return this.version.value;
    }
    const { version } = await fetchLatestBaileysVersion();
    this.version = { value: version, at: Date.now() };
    return version;
  }

  private stopSocket(id: string) {
    const sock = this.sockets.get(id);
    this.sockets.delete(id);
    void sock?.end(undefined);
  }

  // Deletes a phone number. Its chat agent is paused first: an active agent
  // must have a number, so the foreign key's SET NULL alone would fail.
  private async deleteRow(id: string) {
    this.logins.delete(id);
    this.failures.delete(id);
    await this.prisma.$transaction([
      this.prisma.chatAgent.updateMany({
        where: { phoneNumberId: id },
        data: { phoneNumberId: null, status: 'inactive' },
      }),
      this.prisma.phoneNumber.deleteMany({ where: { id } }),
    ]);
  }

  private makeSocket(state: AuthenticationState, version: WAVersion) {
    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.baileysLogger),
      },
      logger: this.baileysLogger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      // Old messages aren't answered, so there's no point downloading them.
      syncFullHistory: false,
      // Groups, status updates and channels never get a reply, so Baileys
      // acks them without decrypting or storing their sender keys. On a busy
      // number that is most of the traffic, and most of the CPU.
      shouldIgnoreJid: (jid) =>
        isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid),
    });
    // Swapped in before the socket connects, so the history sync fills the
    // capped cache, not Baileys' uncapped one.
    (
      sock.signalRepository.lidMapping as unknown as {
        mappingCache: RecentCache<string>;
      }
    ).mappingCache = new RecentCache(LID_CACHE_SIZE);
    return sock;
  }

  private async connect(id: string, opts: ConnectOptions = {}) {
    const [{ state, saveCreds }, version] = await Promise.all([
      usePrismaAuthState(this.prisma, id),
      this.waVersion(),
    ]);
    const sock = this.makeSocket(state, version);
    this.sockets.set(id, sock);
    let pairingRequested = false;

    sock.ev.on('creds.update', () => {
      saveCreds().catch((err: Error) =>
        this.logger.error(`save creds ${id} failed: ${err.message}`),
      );
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      void (async () => {
        if (qr && opts.pairWith && !state.creds.registered) {
          if (pairingRequested) return;
          pairingRequested = true;
          try {
            const pairingCode = await sock.requestPairingCode(opts.pairWith);
            const login = this.logins.get(id);
            if (login) login.pairingCode = pairingCode;
            opts.onCode?.();
          } catch (err) {
            opts.onError?.(err as Error);
          }
        } else if (qr) {
          const login = this.logins.get(id);
          if (login) {
            login.qrAt = Date.now();
            login.qrCount += 1;
          }
          await this.prisma.phoneNumber.updateMany({
            where: { id },
            data: { status: 'pending_qr', qrCode: qr },
          });
          opts.onCode?.();
        }

        if (connection === 'open') {
          opts.onSettled?.();
          await this.markConnected(id, sock);
        }

        if (connection === 'close') {
          opts.onSettled?.();
          await this.handleClose(
            id,
            sock,
            lastDisconnect?.error,
            !!state.creds.me,
          );
        }
      })().catch((err: Error) => {
        this.logger.error(`connection.update ${id} failed: ${err.message}`);
        this.endLogin(id, 'failed', err.message);
      });
    });

    // Both upsert types are real incoming messages: 'notify' arrived while
    // connected, 'append' was queued by WhatsApp while this socket was down
    // (every restart, reconnect, and the forced reconnect after a scan) and
    // is delivered on connect. Dropping 'append' left those unanswered.
    // History sync comes as messaging-history.set, not here.
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const message of messages) this.answer(id, sock, message);
    });
  }

  // Hands a just-received private text message to the chat agent on this
  // number. Groups, status updates, channels and our own messages are skipped.
  private answer(id: string, sock: WASocket, message: WAMessage) {
    const jid = message.key.remoteJid;
    if (!jid || message.key.fromMe) return;
    if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return;
    const sentAt = Number(message.messageTimestamp ?? 0);
    if (sentAt && Date.now() / 1000 - sentAt > STALE_MESSAGE_SECONDS) return;
    const text = messageText(message.message)?.trim();
    if (!text) return;
    // An "@lid" chat often carries the sender's number as the alternate JID.
    const pnJid = [jid, message.key.remoteJidAlt].find((j) => isPnUser(j));
    const pnUser = pnJid ? jidDecode(pnJid)?.user : undefined;

    this.responder
      .respond({
        phoneNumberId: id,
        peerJid: jid,
        peerPhone: pnUser ? `+${pnUser}` : undefined,
        peerName: message.pushName ?? undefined,
        messageId: message.key.id ?? undefined,
        text,
        send: (reply) => sock.sendMessage(jid, { text: reply }),
        setTyping: (typing) =>
          sock.sendPresenceUpdate(typing ? 'composing' : 'paused', jid),
      })
      .catch((err: Error) =>
        this.logger.error(`answering on ${id} failed: ${err.message}`),
      );
  }

  private async markConnected(id: string, sock: WASocket) {
    const login = this.logins.get(id);
    this.logins.delete(id);
    this.failures.delete(id);
    const waJid = sock.user?.id ?? null;
    const user = waJid ? jidDecode(waJid)?.user : undefined;
    const phoneNumber = user ? `+${user}` : null;
    const row = await this.prisma.phoneNumber.findUnique({ where: { id } });
    if (!row) return;

    const existing = phoneNumber
      ? await this.prisma.phoneNumber.findFirst({
          where: { userId: row.userId, phoneNumber, id: { not: id } },
        })
      : null;
    if (existing) {
      await this.moveOnto(id, sock, existing.id, existing.waJid);
      if (login) reportLogin(login, 'completed', `linked ${phoneNumber}`);
      return;
    }

    await this.prisma.phoneNumber.update({
      where: { id },
      data: {
        status: 'connected',
        qrCode: null,
        waJid,
        phoneNumber,
        lastConnectedAt: new Date(),
      },
    });
    this.logger.log(`${id} connected as ${phoneNumber}`);
    if (login) reportLogin(login, 'completed', `linked ${phoneNumber}`);
  }

  // The account linked a number it already has: the new device's keys move
  // onto that number's row, so its id and chat agent stay as they were, and
  // the login's own row goes away.
  private async moveOnto(
    id: string,
    sock: WASocket,
    targetId: string,
    oldWaJid: string | null,
  ) {
    // The old device is replaced; unlink it so it doesn't keep holding one of
    // the phone's linked-device slots. The new scan has already succeeded, so
    // a failure here is only logged.
    await this.unlink(targetId, oldWaJid).catch((err: Error) =>
      this.logger.warn(
        `unlinking the replaced device of ${targetId} failed: ${err.message}`,
      ),
    );

    this.sockets.delete(id);
    await sock.end(undefined);
    await this.prisma.$transaction([
      this.prisma.whatsAppAuth.deleteMany({
        where: { phoneNumberId: targetId },
      }),
      this.prisma.whatsAppAuth.updateMany({
        where: { phoneNumberId: id },
        data: { phoneNumberId: targetId },
      }),
      this.prisma.phoneNumber.deleteMany({ where: { id } }),
      this.prisma.phoneNumber.update({
        where: { id: targetId },
        data: { status: 'pending_qr', qrCode: null },
      }),
    ]);
    this.relinked.set(id, targetId);
    this.logger.log(`${id} relinked onto existing number ${targetId}`);
    // Reconnecting with the moved keys marks the row connected.
    await this.connect(targetId);
  }

  private async handleClose(
    id: string,
    sock: WASocket,
    error: Error | undefined,
    hasCreds: boolean,
  ) {
    // A socket that was replaced or ended on purpose has nothing to report.
    if (this.sockets.get(id) !== sock) return;
    this.sockets.delete(id);
    if (this.shuttingDown) return;
    const statusCode = closeCode(error);

    // Unlinked from the phone: the keys are useless now.
    if (statusCode === DisconnectReason.loggedOut) {
      this.endLogin(id, 'failed', 'WhatsApp refused the link');
      await this.deleteRow(id);
      this.logger.log(`${id} logged out`);
      return;
    }

    // WhatsApp always closes the socket right after a successful scan or
    // pairing code and expects a fresh connection.
    if (statusCode === DisconnectReason.restartRequired) {
      await this.connect(id);
      return;
    }

    const row = await this.prisma.phoneNumber.findUnique({ where: { id } });
    if (!row) return;

    // A login nobody finished. One that never linked anything is dropped,
    // which is what tells the dashboard to ask for a fresh code.
    if (this.logins.has(id) || !row.waJid || !hasCreds) {
      if (statusCode === DisconnectReason.timedOut) {
        this.endLogin(id, 'expired', 'never completed on the phone');
      } else {
        this.endLogin(
          id,
          'failed',
          `connection closed (${statusCode ?? 'no code'})`,
        );
      }
      if (!row.waJid) {
        await this.deleteRow(id);
        return;
      }
      await this.prisma.phoneNumber.update({
        where: { id },
        data: { status: 'disconnected', qrCode: null },
      });
      return;
    }

    // Another connection took this device over. Only this server holds the
    // device's keys, so that is a newer copy of this server: a deploy starts
    // the new one before stopping the old, and it has already marked the
    // number connected. Writing 'disconnected' here would hide a working
    // number, and reconnecting would make the two kick each other off.
    if (statusCode === DisconnectReason.connectionReplaced) return;

    await this.prisma.phoneNumber.update({
      where: { id },
      data: { status: 'disconnected' },
    });

    // A linked number dropped: keep retrying, backing off while it keeps
    // failing, and spread out (±50%) so numbers that dropped together (a
    // network blip) don't all reconnect in the same instant.
    const failures = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, failures);
    const delay =
      Math.min(
        RECONNECT_DELAY_MS * 2 ** (failures - 1),
        MAX_RECONNECT_DELAY_MS,
      ) *
      (0.5 + Math.random());
    setTimeout(() => {
      if (this.shuttingDown || this.sockets.has(id)) return;
      this.connect(id).catch((err: Error) =>
        this.logger.error(`reconnect ${id} failed: ${err.message}`),
      );
    }, delay);
  }
}

function reportLogin(
  login: Pick<LoginState, 'email' | 'byCode'>,
  outcome: string,
  detail?: string,
) {
  const kind = login.byCode ? 'pairing code' : 'QR scan';
  const suffix = detail ? ` - ${detail}` : '';
  activity(`${kind} ${outcome}: ${login.email}${suffix}`);
}

// The status code Baileys closed a socket with, if any.
function closeCode(error: Error | undefined): number | undefined {
  return (error as { output?: { statusCode?: number } } | undefined)?.output
    ?.statusCode;
}

// The most recently used entries, the oldest dropped past max. It has the
// get/set/clear that Baileys' LIDMappingStore calls on its cache.
class RecentCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Re-inserting moves it to the end; the first key is the oldest.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V) {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.max) {
      const [oldest] = this.entries.keys();
      this.entries.delete(oldest);
    }
    return this;
  }

  clear() {
    this.entries.clear();
  }
}

// WhatsApp's request to drop one linked device, the one Baileys' logout()
// sends, but awaited: query() resolves only once WhatsApp has answered.
function removeDevice(sock: WASocket, jid: string) {
  return sock.query(
    {
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'md' },
      content: [
        {
          tag: 'remove-companion-device',
          attrs: { jid, reason: 'user_initiated' },
        },
      ],
    },
    UNLINK_TIMEOUT_MS,
  );
}

// The text of a message, from the kinds a person types: plain, with a link
// preview or reply, or as a photo/video caption. Disappearing messages wrap
// the real one.
function messageText(
  message: proto.IMessage | null | undefined,
): string | undefined {
  if (!message) return undefined;
  if (message.ephemeralMessage?.message) {
    return messageText(message.ephemeralMessage.message);
  }
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    undefined
  );
}
