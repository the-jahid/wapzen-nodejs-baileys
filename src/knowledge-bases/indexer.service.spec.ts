import type { ConfigService } from '@nestjs/config';
import type { KnowledgeBase } from '../generated/prisma/client';
import { IndexerService, SHARED_NAMESPACE } from './indexer.service';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

// Checks what the indexer sends to Pinecone, for knowledge bases in the
// shared namespace and for older ones with a namespace of their own. fetch is
// faked: Pinecone's plan allows only 100 namespaces, so a live run can't make
// throwaway ones.

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

const shared = {
  id: '11111111-2222-3333-4444-555555555555',
  pineconeNamespace: SHARED_NAMESPACE,
  minChunkSize: 10,
  maxChunkSize: 60,
} as KnowledgeBase;

const legacy = {
  id: '99999999-8888-7777-6666-555555555555',
  pineconeNamespace: 'kb_99999999888877776666555555555555',
  minChunkSize: 10,
  maxChunkSize: 60,
} as KnowledgeBase;

const longText =
  'Abyra ships in three days.\n\nReturns are accepted for fourteen days.';

afterEach(() => jest.restoreAllMocks());

describe('IndexerService in the shared namespace', () => {
  it('prefixes record ids with the knowledge base id', async () => {
    const { indexer, pinecone } = setup();
    let counts: number[] = [];
    await indexer.indexSources(
      shared,
      [{ id: 's1', type: 'text', title: 'Abyra', content: longText }],
      (c) => {
        counts = c;
        return Promise.resolve();
      },
    );
    const [upsert] = pinecone('/vectors/upsert');
    expect(upsert.body.namespace).toBe(SHARED_NAMESPACE);
    expect(upsert.body.vectors.map((v) => v.id)).toEqual([
      `${shared.id}/Abyra`,
      `${shared.id}/Abyra#2`,
    ]);
    expect(upsert.body.vectors[0].metadata.knowledge_base_id).toBe(shared.id);
    expect(counts).toEqual([2]);
  });

  it('deletes one source by its prefixed ids', async () => {
    const { indexer, pinecone } = setup();
    await indexer.deleteSourceVectors(shared, {
      title: 'Abyra',
      chunkCount: 2,
    });
    expect(pinecone('/vectors/delete')[0].body).toEqual({
      namespace: SHARED_NAMESPACE,
      ids: [`${shared.id}/Abyra`, `${shared.id}/Abyra#2`],
    });
  });

  it('purges only its own prefix, across list pages, never deleteAll', async () => {
    const { indexer, pinecone } = setup([
      { ids: [`${shared.id}/A`], next: 'page2' },
      { ids: [`${shared.id}/B`] },
    ]);
    await indexer.purgeNamespace(shared);
    const lists = pinecone('/vectors/list');
    expect(lists).toHaveLength(2);
    const first = new URL(lists[0].url).searchParams;
    expect(first.get('namespace')).toBe(SHARED_NAMESPACE);
    expect(first.get('prefix')).toBe(`${shared.id}/`);
    expect(new URL(lists[1].url).searchParams.get('paginationToken')).toBe(
      'page2',
    );
    const deletes = pinecone('/vectors/delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body).toEqual({
      namespace: SHARED_NAMESPACE,
      ids: [`${shared.id}/A`, `${shared.id}/B`],
    });
  });

  it('sends no delete when the prefix holds nothing', async () => {
    const { indexer, pinecone } = setup([{ ids: [] }]);
    await indexer.purgeNamespace(shared);
    expect(pinecone('/vectors/delete')).toHaveLength(0);
  });

  it('searches shared bases in one filtered query and older ones on their own', async () => {
    const { indexer, pinecone } = setup();
    const other = { ...shared, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    const snippets = await indexer.search(
      [shared, legacy, other],
      'when are you open',
      4,
    );
    const queries = pinecone('/query').map((c) => c.body);
    expect(queries).toHaveLength(2);
    expect(queries[0].namespace).toBe(legacy.pineconeNamespace);
    expect(queries[0].filter).toBeUndefined();
    expect(queries[1].namespace).toBe(SHARED_NAMESPACE);
    expect(queries[1].filter).toEqual({
      knowledge_base_id: { $in: [shared.id, other.id] },
    });
    expect(snippets[0]).toMatchObject({ title: 'Guide' });
  });
});

describe('IndexerService for an older knowledge base', () => {
  it('keeps bare title ids in its own namespace', async () => {
    const { indexer, pinecone } = setup();
    await indexer.indexSources(
      legacy,
      [{ id: 's1', type: 'text', title: 'Abyra', content: longText }],
      async () => {},
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
