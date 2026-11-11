import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChatToolbox } from '../tools/chat-toolbox';
import {
  clearWebsiteCache,
  pageForModel,
  parseHtml,
  READ_WEBSITE_FUNCTION,
  readWebsitePage,
  siteRoot,
} from './website-reader';

const HOME = `<!doctype html><html><head><title>Rahim&#39;s Bakery</title>
<meta name="description" content="Fresh bread &amp; cakes in Dhaka">
<style>body{color:red}</style><script>var secret = "do not show";</script></head>
<body><nav><a href="/menu">Our Menu</a> <a href="/contact#map">Contact</a>
<a href="https://instagram.com/rahim">Instagram</a> <a href="/logo.png">Logo</a>
<a href="tel:+8801700000000">Call us</a></nav>
<h1>Welcome</h1><p>Open daily&nbsp;8am&ndash;10pm.</p><!-- hidden note -->
<ul><li>Bread</li><li>Cakes</li></ul></body></html>`;
const MENU = `<html><body><h2>Menu</h2><table><tr><td>Chocolate cake</td><td>৳ 1,200</td></tr></table>
<a href="/">Home</a></body></html>`;

describe('website reader', () => {
  let server: Server;
  let base: string;
  const hits: string[] = [];

  beforeAll(async () => {
    process.env.TOOL_ALLOW_PRIVATE_TARGETS = 'true';
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(HOME);
      }
      if (req.url === '/menu') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(MENU);
      }
      if (req.url === '/old-menu') {
        res.writeHead(301, { Location: '/menu' });
        return res.end();
      }
      if (req.url === '/away') {
        res.writeHead(302, { Location: 'https://example.org/' });
        return res.end();
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.TOOL_ALLOW_PRIVATE_TARGETS;
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    clearWebsiteCache();
    hits.length = 0;
  });

  it('reads what an owner types as a site address', () => {
    expect(siteRoot('shop.com')?.toString()).toBe('https://shop.com/');
    expect(siteRoot(' https://www.shop.com/en#top ')?.toString()).toBe(
      'https://www.shop.com/en',
    );
    expect(siteRoot('')).toBeNull();
    expect(siteRoot('shop')).toBeNull();
    expect(siteRoot('ftp://shop.com')).toBeNull();
    expect(siteRoot('javascript:alert(1)')).toBeNull();
    expect(siteRoot('https://user:pw@shop.com')).toBeNull();
  });

  it('turns HTML into text and keeps only the site’s own page links', () => {
    const root = new URL('https://www.bakery.com/');
    const page = parseHtml(HOME, root, root);
    expect(page.title).toBe("Rahim's Bakery");
    expect(page.description).toBe('Fresh bread & cakes in Dhaka');
    expect(page.text).toContain('Open daily 8am–10pm.');
    expect(page.text).toContain('- Bread\n- Cakes');
    expect(page.text).not.toMatch(/secret|color:red|hidden note/);
    expect(page.links).toEqual([
      { label: 'Our Menu', url: 'https://www.bakery.com/menu' },
      { label: 'Contact', url: 'https://www.bakery.com/contact' },
    ]);
    expect(page.contacts).toEqual(['tel:+8801700000000']);
  });

  it('reads pages of the site, follows redirects on it, and caches them', async () => {
    const root = siteRoot(base)!;
    const home = await readWebsitePage(root);
    expect(home.title).toBe("Rahim's Bakery");
    const menu = await readWebsitePage(root, '/old-menu');
    expect(menu.url).toBe(`${base}/menu`);
    expect(pageForModel(menu)).toContain('Chocolate cake | ৳ 1,200');
    await readWebsitePage(root);
    expect(hits).toEqual(['/', '/old-menu', '/menu']);
  });

  it('refuses pages off the site, files, missing pages and redirects away', async () => {
    const root = siteRoot(base)!;
    await expect(
      readWebsitePage(root, 'https://evil.example/'),
    ).rejects.toThrow(/Only pages on 127.0.0.1/);
    await expect(readWebsitePage(root, '/logo.png')).rejects.toThrow(/a file/);
    await expect(readWebsitePage(root, '/missing')).rejects.toThrow(
      /does not exist/,
    );
    await expect(readWebsitePage(root, '/away')).rejects.toThrow(/moved off/);
  });

  it('refuses internal addresses unless allowed', async () => {
    delete process.env.TOOL_ALLOW_PRIVATE_TARGETS;
    try {
      await expect(readWebsitePage(siteRoot(base)!)).rejects.toThrow(
        /could not be reached/,
      );
    } finally {
      process.env.TOOL_ALLOW_PRIVATE_TARGETS = 'true';
    }
  });

  it('gives the agent a read_website tool and the home page in its prompt', async () => {
    const root = siteRoot(base)!;
    const send = jest.fn();
    expect(ChatToolbox.for([], 'agent', send)).toBeNull();

    const home = await readWebsitePage(root);
    const box = ChatToolbox.for([], 'agent', send, undefined, [], {
      root,
      home,
    })!;
    expect(box.definitions().map((d) => d.function.name)).toEqual([
      READ_WEBSITE_FUNCTION,
    ]);
    expect(box.websitePrompt).toContain(`The business's website is ${base}/`);
    expect(box.websitePrompt).toContain('Open daily 8am–10pm.');
    expect(box.websitePrompt).toContain(`- Our Menu: ${base}/menu`);

    const result = await box.run(READ_WEBSITE_FUNCTION, {
      url: `${base}/menu`,
    });
    expect(result).toContain('Chocolate cake');
    const refused = await box.run(READ_WEBSITE_FUNCTION, {
      url: 'https://evil.example/',
    });
    expect(refused).toMatch(/^Only pages on/);

    // Without the home page the prompt tells the model to read it.
    const bare = ChatToolbox.for([], 'agent', send, undefined, [], { root })!;
    expect(bare.websitePrompt).toContain('with no url to read the home page');
  });
});
