import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Logger } from '@nestjs/common';
import {
  DEFAULT_TIMEOUT_SECONDS,
  normalizeMethod,
  type ApiRequestConfig,
  type ResolvedTool,
  type ToolParameter,
} from './tools.types';

// Runs an api_request tool, ported from the Go server's internal/agenttools:
// the model's arguments are checked against the declared parameters, the
// request goes out through a guard that refuses internal addresses, and the
// response comes back as text the model reads. A failure is never thrown; it
// is reported as text so the agent can say it couldn't do something.

// What an api_request tool hands back to the model. The person is waiting
// while it's read, so a verbose endpoint is cut rather than allowed to set the
// reply's latency on its own.
const RESPONSE_MAX_CHARS = 3000;
// What is read off the wire at all, so a URL pointing at a large download
// can't be pulled into memory before the cut above applies.
const BODY_READ_LIMIT = 1 << 20;
// What a test hands back to the dashboard: far more than the model gets,
// because whoever tests a tool needs to see what the endpoint really sent.
const TEST_BODY_MAX_CHARS = 20_000;
const MAX_REDIRECTS = 3;

// Opts a deployment into letting tools reach private and loopback addresses.
// Off by default: tool URLs are supplied by account holders, and a server
// that fetches any URL for them reaches whatever sits next to it.
const ALLOW_PRIVATE_TARGETS_ENV = 'TOOL_ALLOW_PRIVATE_TARGETS';

const NOT_CONFIGURED =
  'This action is not configured correctly. Tell them you cannot do that right now.';
const NOT_COMPLETED =
  'The request could not be completed. Tell them you cannot look that up right now.';
const ASYNC_SENT =
  'The request was sent. Carry on with the conversation; there is no result to report.';

const logger = new Logger('ToolRunner');

export type TestResult = {
  ok: boolean;
  status_code?: number;
  duration_ms: number;
  request?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
  content_type?: string;
  body: string;
  truncated: boolean;
  error?: string;
  model_result: string;
};

type Prepared = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
};

type Response = { status: number; contentType: string; body: string };

// The JSON Schema the model fills in for a tool. send_text asks for the
// message only when the tool doesn't carry a fixed one.
export function parameterSchema(tool: ResolvedTool) {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  if (tool.type === 'api_request') {
    for (const p of tool.apiRequest?.parameters ?? []) {
      const name = p.name.trim();
      if (!name) continue;
      properties[name] = {
        type: p.type.trim() || 'string',
        description: p.description,
      };
      if (p.required) required.push(name);
    }
  } else if (tool.type === 'send_text' && !tool.sendText?.body.trim()) {
    properties.message = {
      type: 'string',
      description: 'The message to send on WhatsApp.',
    };
    required.push('message');
  }
  return {
    type: 'object' as const,
    properties,
    required,
    additionalProperties: false,
  };
}

// Performs the tool's request and returns the text the model reads. label
// prefixes log lines so a call can be traced to the chat it ran in.
export async function runApiRequest(
  tool: ResolvedTool,
  args: Record<string, unknown>,
  label: string,
): Promise<string> {
  const cfg = tool.apiRequest;
  if (!cfg?.url.trim()) {
    logger.warn(`${label} tool ${tool.name} has no request configured`);
    return NOT_CONFIGURED;
  }
  const missing = missingRequired(cfg.parameters, args);
  if (missing.length) return missingResult(missing);

  let prepared: Prepared;
  try {
    prepared = buildRequest(cfg, args);
  } catch (err) {
    logger.warn(
      `${label} tool ${tool.name} could not be prepared: ${(err as Error).message}`,
    );
    return NOT_CONFIGURED;
  }
  const timeoutMs = timeoutOf(cfg);

  // Fired and forgotten so the agent can carry on; the result is never read.
  if (cfg.async) {
    send(prepared, timeoutMs).then(
      (res) =>
        logger.log(`${label} async tool ${tool.name} returned ${res.status}`),
      (err: Error) =>
        logger.warn(`${label} async tool ${tool.name} failed: ${err.message}`),
    );
    return ASYNC_SENT;
  }

  const startedAt = Date.now();
  try {
    const res = await send(prepared, timeoutMs);
    logger.log(
      `${label} tool ${tool.name} ${prepared.method} ${redactedUrl(prepared.url)} returned ${res.status} in ${Date.now() - startedAt}ms`,
    );
    return resultForModel(res.status, res.body);
  } catch (err) {
    logger.warn(
      `${label} tool ${tool.name} failed after ${Date.now() - startedAt}ms: ${(err as Error).message}`,
    );
    return NOT_COMPLETED;
  }
}

// Runs the tool once and reports the whole exchange. It goes through the same
// builder and address guard as a live chat, so a tool that passes here
// behaves the same in a conversation. An async tool is still awaited: the
// point of a test is to see the response.
export async function testApiRequest(
  cfg: ApiRequestConfig,
  args: Record<string, unknown>,
): Promise<TestResult> {
  const blank = { ok: false, duration_ms: 0, body: '', truncated: false };
  if (!cfg.url.trim()) {
    return {
      ...blank,
      error: 'This tool has no URL configured.',
      model_result: '',
    };
  }
  const missing = missingRequired(cfg.parameters, args);
  if (missing.length) {
    return {
      ...blank,
      error: `Missing required argument(s): ${missing.join(', ')}`,
      model_result: missingResult(missing),
    };
  }

  let prepared: Prepared;
  try {
    prepared = buildRequest(cfg, args);
  } catch (err) {
    return {
      ...blank,
      error: `The request could not be prepared: ${(err as Error).message}`,
      model_result: '',
    };
  }
  const request = describeRequest(prepared);

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await send(prepared, timeoutOf(cfg));
  } catch (err) {
    return {
      ...blank,
      duration_ms: Date.now() - startedAt,
      request,
      error: (err as Error).message,
      model_result: NOT_COMPLETED,
    };
  }
  const truncated = res.body.length > TEST_BODY_MAX_CHARS;
  return {
    ok: res.status < 400,
    status_code: res.status,
    duration_ms: Date.now() - startedAt,
    request,
    ...(res.contentType ? { content_type: res.contentType } : {}),
    body: truncated ? res.body.slice(0, TEST_BODY_MAX_CHARS) : res.body,
    truncated,
    model_result: cfg.async ? ASYNC_SENT : resultForModel(res.status, res.body),
  };
}

// The required parameters the model left out. A blank value is as unusable
// as a missing one; false and 0 render non-empty, so a real value is kept.
export function missingRequired(
  parameters: ToolParameter[],
  args: Record<string, unknown>,
): string[] {
  return parameters
    .filter((p) => p.required && p.name.trim())
    .map((p) => p.name.trim())
    .filter((name) => {
      const value = args[name];
      return value == null || !argumentToString(value).trim();
    });
}

// Turns the configuration and the model's arguments into one request. On GET
// and DELETE the arguments become the query string, otherwise the JSON body.
// Only declared parameters are forwarded: a field the model invents would
// otherwise be sent to somebody's API as if the tool had asked for it.
export function buildRequest(
  cfg: ApiRequestConfig,
  args: Record<string, unknown>,
): Prepared {
  const method = normalizeMethod(cfg.method);
  const url = new URL(cfg.url.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('url must use http or https');
  }

  const declared: Record<string, unknown> = {};
  for (const p of cfg.parameters) {
    const name = p.name.trim();
    if (name && args[name] != null) declared[name] = args[name];
  }

  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (method === 'GET' || method === 'DELETE') {
    for (const [name, value] of Object.entries(declared)) {
      url.searchParams.set(name, argumentToString(value));
    }
  } else {
    body = JSON.stringify(declared);
    headers['Content-Type'] = 'application/json';
  }
  headers['Accept'] = 'application/json';
  for (const h of cfg.headers) {
    const key = h.key.trim();
    if (!key) continue;
    // Header names are case-insensitive, so a configured one replaces ours.
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === key.toLowerCase())
        delete headers[existing];
    }
    headers[key] = h.value;
  }
  return { method, url, headers, body };
}

// One model-supplied argument as text: 3 renders as "3", not "3.0".
export function argumentToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value == null) return '';
  return JSON.stringify(value);
}

function missingResult(missing: string[]) {
  return `Missing required argument(s): ${missing.join(', ')}. Ask for them, then call the tool again.`;
}

function resultForModel(status: number, body: string) {
  if (status >= 400) {
    // The status is worth passing on (a 404 is "no such booking"), but an
    // error page's body isn't, and repeating one back is the failure to avoid.
    return `The request failed with status ${status}. Tell them you could not complete that.`;
  }
  if (!body) {
    return `The request succeeded (status ${status}) and returned no content.`;
  }
  const text =
    body.length > RESPONSE_MAX_CHARS
      ? `${body.slice(0, RESPONSE_MAX_CHARS)}\n… (response truncated)`
      : body;
  return `The request succeeded (status ${status}). Response:\n${text}`;
}

function timeoutOf(cfg: ApiRequestConfig) {
  return (
    (cfg.timeout_seconds > 0 ? cfg.timeout_seconds : DEFAULT_TIMEOUT_SECONDS) *
    1000
  );
}

// Sends the request, following up to MAX_REDIRECTS redirects. The timeout
// covers the whole exchange, redirects included.
async function send(prepared: Prepared, timeoutMs: number): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let current = prepared;
  for (let hop = 0; ; hop++) {
    const res = await sendOnce(current, deadline);
    if (!('location' in res)) return res;
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    current = redirected(current, res.status, res.location);
  }
}

// The request a redirect asks for, as Go's client builds it: 301/302/303 turn
// a non-GET into a bodiless GET, 307/308 repeat the request as it was, and
// credentials are not carried to a different host.
function redirected(
  prev: Prepared,
  status: number,
  location: string,
): Prepared {
  const url = new URL(location, prev.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('redirect to a non-http url');
  }
  const headers = { ...prev.headers };
  let { method, body } = prev;
  if (status !== 307 && status !== 308 && method !== 'GET') {
    method = 'GET';
    body = undefined;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') delete headers[key];
    }
  }
  if (url.host !== prev.url.host) {
    for (const key of Object.keys(headers)) {
      if (
        ['authorization', 'cookie', 'www-authenticate'].includes(
          key.toLowerCase(),
        )
      ) {
        delete headers[key];
      }
    }
  }
  return { method, url, headers, body };
}

function sendOnce(
  req: Prepared,
  signal: AbortSignal,
): Promise<Response | { status: number; location: string }> {
  return new Promise((resolve, reject) => {
    // An IP literal never goes through the lookup below, so it is checked here.
    const literal = req.url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && blocked(literal)) {
      return reject(refused(literal));
    }
    const client = req.url.protocol === 'https:' ? https : http;
    const outgoing = client.request(
      req.url,
      {
        method: req.method,
        headers: {
          ...req.headers,
          ...(req.body !== undefined
            ? { 'Content-Length': String(Buffer.byteLength(req.body)) }
            : {}),
        },
        lookup: guardedLookup,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          return resolve({ status, location });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size >= BODY_READ_LIMIT) return;
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () =>
          resolve({
            status,
            contentType: res.headers['content-type'] ?? '',
            body: Buffer.concat(chunks)
              .subarray(0, BODY_READ_LIMIT)
              .toString('utf8')
              .trim(),
          }),
        );
        res.on('error', reject);
      },
    );
    outgoing.on('error', (err) =>
      reject(signal.aborted ? new Error('the request timed out') : err),
    );
    outgoing.end(req.body);
  });
}

// Resolves the host and refuses an internal answer. The check is on the
// address actually connected to, so a name that resolves somewhere public
// when the tool is saved and to 127.0.0.1 when it runs is still caught.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, list) => {
    if (err) return callback(err, '', 0);
    const bad = list.find((a) => blocked(a.address));
    if (bad) return callback(refused(bad.address), '', 0);
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

const INTERNAL = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10], // carrier-grade NAT
    ['127.0.0.0', 8],
    ['169.254.0.0', 16], // link-local, including cloud metadata
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['224.0.0.0', 4], // multicast
    ['255.255.255.255', 32],
  ] as const) {
    list.addSubnet(net, prefix, 'ipv4');
  }
  for (const [net, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
  ] as const) {
    list.addSubnet(net, prefix, 'ipv6');
  }
  return list;
})();

function blocked(address: string): boolean {
  if (allowPrivateTargets()) return false;
  // An IPv4-mapped IPv6 address reaches the IPv4 host it wraps.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return INTERNAL.check(mapped[1], 'ipv4');
  return INTERNAL.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

function refused(address: string) {
  return new Error(
    `refusing to reach internal address ${address}; set ${ALLOW_PRIVATE_TARGETS_ENV}=true to allow it`,
  );
}

function allowPrivateTargets() {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env[ALLOW_PRIVATE_TARGETS_ENV] ?? '').trim().toLowerCase(),
  );
}

// The request as sent, for a test result. Credentials are masked even though
// they go back to their owner: a test result ends up in screenshots.
function describeRequest(req: Prepared): TestResult['request'] {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = isSecretHeader(key) ? maskSecret(value) : value;
  }
  return {
    method: req.method,
    url: req.url.toString(),
    headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
  };
}

function isSecretHeader(key: string) {
  const lower = key.toLowerCase();
  return ['authorization', 'token', 'secret', 'key', 'cookie', 'password'].some(
    (marker) => lower.includes(marker),
  );
}

function maskSecret(value: string) {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-2)}`;
}

// The URL for a log line, without the query string, which is where the
// model's arguments (a phone number, a booking reference) end up on a GET.
function redactedUrl(url: URL) {
  const copy = new URL(url);
  copy.search = '';
  copy.username = '';
  copy.password = '';
  return copy.toString();
}
