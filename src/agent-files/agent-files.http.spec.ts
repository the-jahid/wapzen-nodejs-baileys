import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AgentFilesController } from './agent-files.controller';
import { AgentFilesService } from './agent-files.service';
import { MAX_FILE_BYTES, MAX_FILES_PER_AGENT } from './agent-files.types';

// Real uploads, through multer, into a real Postgres over pg.

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../auth/auth.guard', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createParamDecorator } = require('@nestjs/common') as {
    createParamDecorator: typeof import('@nestjs/common').createParamDecorator;
  };
  return {
    ClerkAuthGuard: class {},
    CurrentUser: createParamDecorator(() => ({ id: 'user1' })),
  };
});

const PORT = 55482;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 1, 2]);
const PDF = Buffer.from('%PDF-1.7 hello');
const MINE = 'agent-mine';
const NOTE = 'When someone asks for the menu';

async function appWith(files: AgentFilesService) {
  const moduleRef = await Test.createTestingModule({
    controllers: [AgentFilesController],
    providers: [
      { provide: AgentFilesService, useValue: files },
      {
        provide: PrismaService,
        useValue: {
          // Only this agent belongs to the signed-in user.
          chatAgent: {
            count: ({ where }: { where: { id: string; userId: string } }) =>
              Promise.resolve(
                where.id === MINE && where.userId === 'user1' ? 1 : 0,
              ),
          },
        },
      },
    ],
  })
    .overrideGuard(ClerkAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('the files routes', () => {
  let server: PGLiteSocketServer;
  let pg: PGlite;
  let files: AgentFilesService;
  let app: INestApplication;
  const ignore = () => undefined;

  beforeAll(async () => {
    process.on('uncaughtException', ignore);
    pg = await PGlite.create();
    server = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1' });
    await server.start();
    files = new AgentFilesService({
      get: (key: string) =>
        key === 'FILES_DATABASE_URL'
          ? `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`
          : undefined,
    } as unknown as ConfigService);
    app = await appWith(files);
  });

  afterAll(async () => {
    await app.close();
    await server.stop();
    await pg.close();
    process.off('uncaughtException', ignore);
  });

  beforeEach(async () => {
    for (const file of await files.list(MINE)) {
      await files.remove(MINE, file.id);
    }
  });

  const http = () => request(app.getHttpServer() as never);
  const url = `/v1/dashboard/chat-agents/${MINE}/files`;
  const upload = (name: string, data: Buffer, description: string = NOTE) =>
    http()
      .post(url)
      .field('description', description)
      .attach('file', data, name);

  it('stores an upload and lists it without the bytes', async () => {
    const res = await upload('মেনু.png', PNG).expect(201);
    const body = res.body as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      file_name: 'মেনু.png',
      mime_type: 'image/png',
      size_bytes: PNG.length,
      description: NOTE,
    });
    expect(body.data.data).toBeUndefined();

    const list = await http().get(url).expect(200);
    expect((list.body as { data: unknown[] }).data).toHaveLength(1);
    const stored = await files.content(MINE, body.data.id as string);
    expect(Buffer.compare(stored.data, PNG)).toBe(0);
  });

  it('answers the public path too', async () => {
    await http().get(`/v1/chat-agents/${MINE}/files`).expect(200);
  });

  it('squeezes a description onto one line, and needs one', async () => {
    const res = await upload('a.pdf', PDF, '  ask\n\n  for   it ').expect(201);
    expect(
      (res.body as { data: { description: string } }).data.description,
    ).toBe('ask for it');
    await upload('a.pdf', PDF, '   ').expect(400);
    await http().post(url).attach('file', PDF, 'a.pdf').expect(400);
    await upload('a.pdf', PDF, 'x'.repeat(301)).expect(400);
  });

  it.each([
    ['a video', 'clip.mp4', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])],
    ['a program named .pdf', 'menu.pdf', Buffer.from('MZ\x90\0')],
  ])('refuses %s, saying what it takes', async (_label, name, data) => {
    const res = await upload(name, data).expect(400);
    expect((res.body as { message: string }).message).toContain('pdf, doc');
    expect(await files.count(MINE)).toBe(0);
  });

  it('refuses a file over the size limit', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES)]);
    const res = await upload('big.pdf', big).expect(400);
    expect((res.body as { message: string }).message).toContain('10 MB');
    expect(await files.count(MINE)).toBe(0);
  });

  it('takes the largest file allowed', async () => {
    const data = Buffer.concat([
      PDF,
      Buffer.alloc(MAX_FILE_BYTES - PDF.length),
    ]);
    const res = await upload('big.pdf', data).expect(201);
    const { id } = (res.body as { data: { id: string } }).data;
    expect((await files.content(MINE, id)).data.length).toBe(MAX_FILE_BYTES);
  });

  it('refuses a request that is not multipart', async () => {
    await http().post(url).send({ description: NOTE }).expect(400);
  });

  it('holds at most the limit per agent', async () => {
    for (let i = 0; i < MAX_FILES_PER_AGENT; i++) {
      await files.add({
        userId: 'user1',
        agentId: MINE,
        fileName: `f${i}.pdf`,
        mimeType: 'application/pdf',
        description: NOTE,
        data: PDF,
      });
    }
    await upload('one-more.pdf', PDF).expect(409);
  });

  it('deletes a file, once', async () => {
    const res = await upload('a.pdf', PDF).expect(201);
    const { id } = (res.body as { data: { id: string } }).data;
    await http().delete(`${url}/${id}`).expect(200);
    await http().delete(`${url}/${id}`).expect(404);
  });

  it('hides another account’s agent on every route', async () => {
    const other = '/v1/dashboard/chat-agents/agent-theirs/files';
    await http().get(other).expect(404);
    await http()
      .post(other)
      .field('description', NOTE)
      .attach('file', PDF, 'a.pdf')
      .expect(404);
    await http().delete(`${other}/some-file`).expect(404);
  });

  it('answers 503 when the database is not set up, and when it is down', async () => {
    const off = new AgentFilesService({
      get: () => undefined,
    } as unknown as ConfigService);
    const offApp = await appWith(off);
    await request(offApp.getHttpServer() as never)
      .get(url)
      .expect(503);
    await offApp.close();

    const down = new AgentFilesService({
      get: () => 'postgresql://postgres:wrong@127.0.0.1:1/postgres',
    } as unknown as ConfigService);
    const downApp = await appWith(down);
    await request(downApp.getHttpServer() as never)
      .get(url)
      .expect(503);
    await downApp.close();
  });
});
