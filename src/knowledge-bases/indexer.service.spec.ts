import type { ConfigService } from '@nestjs/config';
import type { KnowledgeBase } from '../generated/prisma/client';
import { IndexerService, userNamespace } from './indexer.service';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

// Checks what the indexer sends to Pinecone, for knowledge bases in their
// owner's namespace and for older ones with a namespace of their own. fetch
// is faked so nothing reaches a real index.

const HOST = 'https://index.test';
const DIM = 4;
const env: Record<string, string> = {
  OPENAI_API_KEY: 'sk-test',
  PINECONE_API_KEY: 'pc-test',
  PINECONE_INDEX_HOST: HOST,
  PINECONE_INDEX_DIMENSION: String(DIM),
};

type Body = {
  input: string[];
  namespace?: string;
  ids?: string[];
  filter?: unknown;
  vectors: { id: string; metadata: Record<string, unknown> }[];
};
type Call = { url: string; method: string; body: Body };

function setup(listPages: { ids: string[]; next?: string }[] = []) {
  const calls: Call[] = [];
  const pages = [...listPages];
  jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const url = input as string;
    const body = (
      typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    ) as Body;
    calls.push({ url, method: init?.method ?? 'GET', body });
    let json: unknown = {};
    if (url.endsWith('/v1/embeddings')) {
      json = {
        data: body.input.map((_, index) => ({
          index,
          embedding: Array(DIM).fill(0.5),
        })),
      };
    } else if (url.includes('/vectors/list')) {
      const page = pages.shift() ?? { ids: [] };
      json = {
        vectors: page.ids.map((id) => ({ id })),
        ...(page.next ? { pagination: { next: page.next } } : {}),
      };
    } else if (url.endsWith('/query')) {
      json = {
        matches: [
          {
            id: 'x',
            score: 0.5,
            metadata: { title: 'Guide', text: 'Opening hours are 9-5.' },
          },
        ],
      };
    }
    return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));
  });
  const indexer = new IndexerService({
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  } as unknown as ConfigService);
  const pinecone = (path: string) =>
    calls.filter((c) => c.url.startsWith(HOST + path));
  return { indexer, calls, pinecone };
}

const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002';

// Two knowledge bases of user A and one of user B, all made since the switch.
const a1 = {
  id: '11111111-2222-3333-4444-555555555555',
  userId: USER_A,
  pineconeNamespace: userNamespace(USER_A),
  minChunkSize: 10,
  maxChunkSize: 60,
} as KnowledgeBase;
const a2 = { ...a1, id: '22222222-2222-3333-4444-555555555555' };
const b1 = {
  ...a1,
  id: '33333333-2222-3333-4444-555555555555',
  userId: USER_B,
  pineconeNamespace: userNamespace(USER_B),
};

const legacy = {
  id: '99999999-8888-7777-6666-555555555555',
  pineconeNamespace: 'kb_99999999888877776666555555555555',
  minChunkSize: 10,
  maxChunkSize: 60,
} as KnowledgeBase;

const longText =
  'Abyra ships in three days.\n\nReturns are accepted for fourteen days.';

afterEach(() => jest.restoreAllMocks());

describe('IndexerService in a user namespace', () => {
  it('names the namespace after the user', () => {
    expect(userNamespace(USER_A)).toBe(`user_${USER_A}`);
  });

  it("writes to the owner's namespace with ids prefixed by the knowledge base", async () => {
    const { indexer, pinecone } = setup();
    let counts: number[] = [];
    await indexer.indexSources(
      a1,
      [{ id: 's1', type: 'text', title: 'Abyra', content: longText }],
      (c) => {
        counts = c;
        return Promise.resolve();
      },
    );
    const [upsert] = pinecone('/vectors/upsert');
    expect(upsert.body.namespace).toBe(`user_${USER_A}`);
    expect(upsert.body.vectors.map((v) => v.id)).toEqual([
      `${a1.id}/Abyra`,
      `${a1.id}/Abyra#2`,
    ]);
    expect(upsert.body.vectors[0].metadata.knowledge_base_id).toBe(a1.id);
    expect(counts).toEqual([2]);
  });

  it('deletes one source by its prefixed ids', async () => {
    const { indexer, pinecone } = setup();
    await indexer.deleteSourceVectors(a1, { title: 'Abyra', chunkCount: 2 });
    expect(pinecone('/vectors/delete')[0].body).toEqual({
      namespace: `user_${USER_A}`,
      ids: [`${a1.id}/Abyra`, `${a1.id}/Abyra#2`],
    });
  });

  it("purges only that knowledge base's prefix, across list pages, never deleteAll", async () => {
    const { indexer, pinecone } = setup([
      { ids: [`${a1.id}/A`], next: 'page2' },
      { ids: [`${a1.id}/B`] },
    ]);
    await indexer.purgeNamespace(a1);
    const lists = pinecone('/vectors/list');
    expect(lists).toHaveLength(2);
    const first = new URL(lists[0].url).searchParams;
    expect(first.get('namespace')).toBe(`user_${USER_A}`);
    expect(first.get('prefix')).toBe(`${a1.id}/`);
    expect(new URL(lists[1].url).searchParams.get('paginationToken')).toBe(
      'page2',
    );
    const deletes = pinecone('/vectors/delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body).toEqual({
      namespace: `user_${USER_A}`,
      ids: [`${a1.id}/A`, `${a1.id}/B`],
    });
  });

  it('sends no delete when the prefix holds nothing', async () => {
    const { indexer, pinecone } = setup([{ ids: [] }]);
    await indexer.purgeNamespace(a1);
    expect(pinecone('/vectors/delete')).toHaveLength(0);
  });

  it("searches only the agent's attached bases in their owner's namespace", async () => {
    const { indexer, pinecone } = setup();
    // a2 belongs to the same user but isn't attached, so it must not be searched.
    const snippets = await indexer.search([a1], 'when are you open', 4);
    const queries = pinecone('/query').map((c) => c.body);
    expect(queries).toEqual([
      expect.objectContaining({
        namespace: `user_${USER_A}`,
        filter: { knowledge_base_id: { $in: [a1.id] } },
      }),
    ]);
    expect(snippets[0]).toMatchObject({ title: 'Guide' });
  });

  it('asks each namespace once, filtered, and older ones unfiltered', async () => {
    const { indexer, pinecone } = setup();
    await indexer.search([a1, legacy, a2, b1], 'when are you open', 4);
    const queries = pinecone('/query').map((c) => c.body);
    expect(queries).toHaveLength(3);
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: `user_${USER_A}`,
          filter: { knowledge_base_id: { $in: [a1.id, a2.id] } },
        }),
        expect.objectContaining({
          namespace: `user_${USER_B}`,
          filter: { knowledge_base_id: { $in: [b1.id] } },
        }),
      ]),
    );
    const own = queries.find((q) => q.namespace === legacy.pineconeNamespace);
    expect(own?.filter).toBeUndefined();
  });
});

describe('IndexerService for an older knowledge base', () => {
  it('keeps bare title ids in its own namespace', async () => {
    const { indexer, pinecone } = setup();
    await indexer.indexSources(
      legacy,
      [{ id: 's1', type: 'text', title: 'Abyra', content: longText }],
      () => Promise.resolve(),
    );
    const [upsert] = pinecone('/vectors/upsert');
    expect(upsert.body.namespace).toBe(legacy.pineconeNamespace);
    expect(upsert.body.vectors.map((v) => v.id)).toEqual(['Abyra', 'Abyra#2']);
  });

  it('still purges with deleteAll on its namespace', async () => {
    const { indexer, pinecone } = setup();
    await indexer.purgeNamespace(legacy);
    expect(pinecone('/vectors/list')).toHaveLength(0);
    expect(pinecone('/vectors/delete')[0].body).toEqual({
      namespace: legacy.pineconeNamespace,
      deleteAll: true,
    });
  });
});
