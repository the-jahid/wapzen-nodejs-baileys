import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { ConfigService } from '@nestjs/config';
import { ChatToolbox, SEND_FILE_FUNCTION } from '../tools/chat-toolbox';
import type { ChatFile } from '../tools/chat-toolbox';
import { AgentFilesService } from './agent-files.service';
import { cleanFileName, detectMimeType } from './agent-files.types';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

const PORT = 55481;
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 1, 2]);
const PDF = Buffer.from('%PDF-1.7 hello');

const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('what can be uploaded', () => {
  it.each([
    ['menu.pdf', PDF, 'application/pdf'],
    ['MENU.PDF', PDF, 'application/pdf'],
    ['photo.png', PNG, 'image/png'],
    ['list.csv', Buffer.from('a,b\n1,2'), 'text/csv'],
    [
      'report.docx',
      Buffer.from([0x50, 0x4b, 3, 4, 9]),
      expect.stringContaining('wordprocessingml'),
    ],
  ])('takes %s', (name, data, mime) => {
    expect(detectMimeType(name, data)).toEqual(mime);
  });

  it.each([
    ['a video', 'clip.mp4', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])],
    ['a program renamed to .pdf', 'menu.pdf', Buffer.from('MZ\x90\0')],
    ['a program renamed to .png', 'photo.png', Buffer.from('MZ\x90\0')],
    ['binary renamed to .txt', 'notes.txt', Buffer.from([0x41, 0, 0x42])],
    ['an svg', 'logo.svg', Buffer.from('<svg/>')],
    ['no extension', 'menu', PDF],
    ['an inherited property name', 'x.constructor', PDF],
    ['an empty file', 'menu.pdf', Buffer.alloc(0)],
  ])('refuses %s', (_label, name, data) => {
    expect(detectMimeType(name, data)).toBeUndefined();
  });

  it('keeps only the name of a path, without control characters', () => {
    expect(cleanFileName('C:\\Users\\me\\মেনু\n.pdf')).toBe('মেনু.pdf');
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
  });
});

describe('the files database', () => {
  let server: PGLiteSocketServer;
  let pg: PGlite;
  let files: AgentFilesService;
  // The bare socket server has to outlive a client hanging up.
  const ignore = () => undefined;

  beforeAll(async () => {
    process.on('uncaughtException', ignore);
    pg = await PGlite.create();
    server = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1' });
    await server.start();
    files = new AgentFilesService(config({ FILES_DATABASE_URL: URL }));
  });

  afterAll(async () => {
    await files.onModuleDestroy();
    await server.stop();
    await pg.close();
    process.off('uncaughtException', ignore);
  });

  const add = (agentId: string, userId = 'user-1', fileName = 'menu.pdf') =>
    files.add({
      userId,
      agentId,
      fileName,
      mimeType: 'application/pdf',
      description: 'When someone asks for the menu',
      data: PDF,
    });

  it('makes its table on first use and returns the bytes unchanged', async () => {
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const added = await files.add({
      userId: 'user-1',
      agentId: 'agent-bytes',
      fileName: 'all.png',
      mimeType: 'image/png',
      description: 'always',
      data: binary,
    });
    expect(added.size_bytes).toBe(256);
    expect(added.created_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect('data' in added).toBe(false);

    const out = await files.content('agent-bytes', added.id);
    expect(Buffer.compare(out.data, binary)).toBe(0);
    expect(out.fileName).toBe('all.png');
  });

  it('never hands one agent another agent’s file', async () => {
    const mine = await add('agent-a');
    await expect(files.content('agent-b', mine.id)).rejects.toThrow('gone');
    expect(await files.remove('agent-b', mine.id)).toBe(false);
    expect((await files.list('agent-a')).map((f) => f.id)).toEqual([mine.id]);
  });

  it('shows a reply a new or deleted file straight away, despite the cache', async () => {
    expect(await files.listForReply('agent-c')).toEqual([]);
    const added = await add('agent-c');
    expect((await files.listForReply('agent-c')).map((f) => f.id)).toEqual([
      added.id,
    ]);
    expect(await files.remove('agent-c', added.id)).toBe(true);
    expect(await files.listForReply('agent-c')).toEqual([]);
  });

  it('removes an agent’s files, and a user’s, and no one else’s', async () => {
    await add('agent-d', 'user-d');
    await add('agent-e', 'user-e');
    await add('agent-f', 'user-e');
    await add('agent-g', 'user-g');

    await files.removeForAgent('agent-d');
    expect(await files.count('agent-d')).toBe(0);

    await files.removeForUser('user-e');
    expect(await files.count('agent-e')).toBe(0);
    expect(await files.count('agent-f')).toBe(0);
    expect(await files.count('agent-g')).toBe(1);
  });

  it('closes the table to Supabase’s public API', async () => {
    const { rows } = await pg.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class WHERE relname = 'agent_files'",
    );
    expect(rows[0].relrowsecurity).toBe(true);
  });
});

describe('with no files database set', () => {
  const files = new AgentFilesService(config({}));

  it('is off, and a reply simply has no files', async () => {
    expect(files.enabled).toBe(false);
    expect(await files.listForReply('agent')).toEqual([]);
    await expect(files.removeForAgent('agent')).resolves.toBeUndefined();
    await expect(files.removeForUser('user')).resolves.toBeUndefined();
  });
});

describe('send_file', () => {
  const send = jest.fn().mockResolvedValue(undefined);
  const file = (key: string, name: string, deliver = jest.fn()): ChatFile => ({
    key,
    name,
    description: `Send ${name} when asked`,
    send: deliver.mockResolvedValue(undefined),
  });

  it('is not offered to an agent with no files', () => {
    expect(ChatToolbox.for([], 'agent', send, undefined, [])).toBeNull();
  });

  it('is offered with only this agent’s keys, and lists the files in the prompt', () => {
    const box = ChatToolbox.for([], 'agent', send, undefined, [
      file('file_1', 'menu.pdf'),
      file('file_2', 'map.png'),
    ])!;
    const [definition] = box.definitions();
    expect(definition.function.name).toBe(SEND_FILE_FUNCTION);
    expect(JSON.stringify(definition.function.parameters)).toContain('file_2');
    expect(definition.function.description.length).toBeLessThan(1024);
    expect(box.filesPrompt).toContain(
      '- file_1 (menu.pdf): Send menu.pdf when asked',
    );
  });

  it('sends a file once per reply, however often the model asks', async () => {
    const deliver = jest.fn();
    const box = ChatToolbox.for([], 'agent', send, undefined, [
      file('file_1', 'menu.pdf', deliver),
    ])!;
    const results = await Promise.all([
      box.run(SEND_FILE_FUNCTION, { file_id: 'file_1' }),
      box.run(SEND_FILE_FUNCTION, { file_id: 'file_1' }),
    ]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(results.join()).toContain('already been sent');
    expect(box.sentFiles).toEqual(['menu.pdf']);
  });

  it('keeps the record’s mark out of what the person reads', async () => {
    const box = ChatToolbox.for([], 'agent', send, undefined, [
      file('file_1', 'menu.pdf'),
    ])!;
    await box.run(SEND_FILE_FUNCTION, { file_id: 'file_1' });
    expect(box.withoutFileMarks('📎 Here’s our shop location.')).toBe(
      'Here’s our shop location.',
    );
    expect(box.withoutFileMarks('Here’s the menu again! 📎 menu.pdf')).toBe(
      'Here’s the menu again!',
    );
    expect(box.withoutFileMarks('📎 menu.pdf\nHere’s the menu')).toBe(
      'Here’s the menu',
    );
    expect(box.withoutFileMarks('Our  menu.pdf has prices.')).toBe(
      'Our  menu.pdf has prices.',
    );
    expect(box.withoutFileMarks('📎 menu.pdf')).toBe('');
  });

  it('refuses an unknown id', async () => {
    const deliver = jest.fn();
    const box = ChatToolbox.for([], 'agent', send, undefined, [
      file('file_1', 'menu.pdf', deliver),
    ])!;
    expect(await box.run(SEND_FILE_FUNCTION, { file_id: 'file_9' })).toContain(
      'no file',
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(box.sentFiles).toEqual([]);
  });

  it('reports a failed send and lets it be tried again', async () => {
    const deliver = jest.fn();
    const box = ChatToolbox.for([], 'agent', send, undefined, [
      file('file_1', 'menu.pdf', deliver),
    ])!;
    deliver.mockRejectedValueOnce(new Error('no socket'));
    expect(await box.run(SEND_FILE_FUNCTION, { file_id: 'file_1' })).toContain(
      'could not be sent',
    );
    expect(box.sentFiles).toEqual([]);
    expect(await box.run(SEND_FILE_FUNCTION, { file_id: 'file_1' })).toContain(
      'has been sent',
    );
    expect(box.sentFiles).toEqual(['menu.pdf']);
  });
});
