import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { countryOf, proxyForNumber, sessionId } from './proxy';

const ROW = '3f9a1c7e-5b2d-4e8f-9a10-1b2c3d4e5f60';

describe('proxyForNumber', () => {
  it('does nothing without WA_PROXY_URL', () => {
    expect(proxyForNumber(ROW, '967781936614', {})).toBeUndefined();
    expect(
      proxyForNumber(ROW, '967781936614', { WA_PROXY_URL: '  ' }),
    ).toBeUndefined();
  });

  it("fills in the number's session and country", () => {
    const proxy = proxyForNumber(ROW, '967781936614', {
      WA_PROXY_URL:
        'http://user-acc-country-{country}-session-{session}:secret@gate.test:7000',
    });
    expect(proxy?.label).toBe('gate.test:7000 session 3f9a1c7e country ye');
    expect(proxy?.label).not.toContain('secret');
  });

  it('falls back to WA_PROXY_COUNTRY, then "us", before the number is known', () => {
    const template = 'http://u-{country}-{session}:p@gate.test:7001';
    expect(
      proxyForNumber(ROW, undefined, {
        WA_PROXY_URL: template,
        WA_PROXY_COUNTRY: 'BR',
      })?.label,
    ).toContain('country br');
    expect(
      proxyForNumber(ROW, undefined, { WA_PROXY_URL: template })?.label,
    ).toContain('country us');
  });

  it('gives the same number the same proxy every time', () => {
    const env = { WA_PROXY_URL: 'http://u-{session}:p@gate.test:7002' };
    expect(proxyForNumber(ROW, '5511999990000', env)).toBe(
      proxyForNumber(ROW, '5511999990000', env),
    );
  });

  it('refuses a proxy that is not http(s)', () => {
    expect(() =>
      proxyForNumber(ROW, undefined, {
        WA_PROXY_URL: 'socks5://gate.test:1080',
      }),
    ).toThrow('http:// or https://');
  });
});

describe('countryOf / sessionId', () => {
  it('reads the country from the digits', () => {
    expect(countryOf('967781936614')).toBe('ye');
    expect(countryOf('8801639726992')).toBe('bd');
    expect(countryOf('5511999990000')).toBe('br');
    expect(countryOf(undefined)).toBeUndefined();
    expect(countryOf('12')).toBeUndefined();
  });

  it('is 8 lower-case letters and digits', () => {
    expect(sessionId(ROW)).toBe('3f9a1c7e');
    expect(sessionId('ABCD-EF12-3456')).toBe('abcdef12');
  });
});

// A real proxy on localhost: the WebSocket must arrive through a CONNECT
// tunnel, and a download as a proxied request.
describe('traffic goes through the proxy', () => {
  let target: Server;
  let wss: WebSocketServer;
  let proxy: Server;
  let targetPort: number;
  let proxyPort: number;
  const seen: string[] = [];

  beforeAll(async () => {
    target = createServer((req, res) => res.end(`file ${req.url}`));
    wss = new WebSocketServer({ server: target });
    wss.on('connection', (ws) => ws.send('hello'));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    targetPort = (target.address() as AddressInfo).port;

    proxy = createServer((req, res) => {
      seen.push(`GET ${req.url}`);
      const out = request(req.url!, { headers: req.headers }, (up) => {
        res.writeHead(up.statusCode!, up.headers);
        up.pipe(res);
      });
      req.pipe(out);
    });
    proxy.on('connect', (req, client, head) => {
      seen.push(`CONNECT ${req.url}`);
      const [host, port] = req.url!.split(':');
      const up = connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    wss.close();
    proxy.closeAllConnections();
    target.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => target.close(r));
  });

  it('carries the WhatsApp socket and media downloads', async () => {
    const numberProxy = proxyForNumber(ROW, '967781936614', {
      WA_PROXY_URL: `http://u-{session}:p@127.0.0.1:${proxyPort}`,
    })!;

    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${targetPort}/ws/chat`, {
        agent: numberProxy.agent,
      });
      ws.on('message', (data) => {
        resolve((data as Buffer).toString());
        ws.close();
      });
      ws.on('error', reject);
    });
    expect(message).toBe('hello');

    const res = await fetch(`http://127.0.0.1:${targetPort}/mms/voice`, {
      dispatcher: numberProxy.dispatcher,
    } as RequestInit);
    expect(await res.text()).toBe('file /mms/voice');
    await numberProxy.dispatcher.close();

    // undici tunnels even a plain-http download; WhatsApp's are https anyway.
    expect(seen).toEqual([
      `CONNECT 127.0.0.1:${targetPort}`,
      `CONNECT 127.0.0.1:${targetPort}`,
    ]);
  });
});
