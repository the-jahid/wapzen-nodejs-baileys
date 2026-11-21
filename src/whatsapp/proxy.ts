import type { Agent } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { ProxyAgent, type Dispatcher } from 'undici';
import { activity } from '../activity/activity';

// WhatsApp removes linked devices it stops trusting (401 device_removed), and
// without a proxy every number on this server connects from the same
// data-centre address, one shared with other hosted WhatsApp bots. Setting
// WA_PROXY_URL sends each number through an HTTP(S) proxy instead, normally a
// residential one, so it connects the way a person's WhatsApp Web would.
//
// Two placeholders make it one address per number, from that number's country:
//   {session}  8 letters and digits, the same for a number every time it
//              connects (residential providers keep a "session" on one IP)
//   {country}  the number's country, lower case ("ye", "br"); WA_PROXY_COUNTRY
//              (default "us") when it isn't known yet, i.e. a QR code login
//              before the phone has scanned it
// e.g. http://user-ACCOUNT-country-{country}-session-{session}:PASS@gate.example.com:7000
//
// Unset, nothing changes. Set, a number whose proxy is down can't connect; it
// keeps retrying like any other dropped connection.

export interface NumberProxy {
  // The WhatsApp connection itself.
  agent: Agent;
  // Media uploads, which Baileys sends with node:https.
  fetchAgent: Agent;
  // Media downloads, which go through fetch.
  dispatcher: Dispatcher;
  // Where it goes, for logs: host, session and country, never the password.
  label: string;
}

const DEFAULT_COUNTRY = 'us';

// One per proxy address, so reconnects reuse the download pool instead of
// leaving a new one behind each time.
const cache = new Map<string, NumberProxy>();

export function proxyForNumber(
  rowId: string,
  phoneDigits: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NumberProxy | undefined {
  const template = env.WA_PROXY_URL?.trim();
  if (!template) return undefined;

  const session = sessionId(rowId);
  const country =
    countryOf(phoneDigits) ??
    (env.WA_PROXY_COUNTRY?.trim().toLowerCase() || DEFAULT_COUNTRY);
  const url = template
    .replaceAll('{session}', session)
    .replaceAll('{country}', country);

  const known = cache.get(url);
  if (known) return known;

  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `WA_PROXY_URL must be an http:// or https:// proxy, not ${parsed.protocol}`,
    );
  }
  // Said once, so the log shows the switch is on.
  if (cache.size === 0) {
    activity(`WhatsApp numbers connect through the proxy at ${parsed.host}`);
  }
  // An https.Agent in all but its type: it tunnels with CONNECT.
  const agent = new HttpsProxyAgent(url) as unknown as Agent;
  const proxy: NumberProxy = {
    agent,
    fetchAgent: agent,
    dispatcher: new ProxyAgent(url),
    label: `${parsed.host} session ${session} country ${country}`,
  };
  cache.set(url, proxy);
  return proxy;
}

// The number's country as an ISO code, from its digits (no '+').
export function countryOf(phoneDigits: string | undefined) {
  if (!phoneDigits || !/^\d{6,15}$/.test(phoneDigits)) return undefined;
  return parsePhoneNumberFromString(`+${phoneDigits}`)?.country?.toLowerCase();
}

// Some providers take only 8 letters and digits as a session id, so it's the
// row id's first 8 hex digits: random in a v4 uuid, and the same on every
// reconnect.
export function sessionId(rowId: string) {
  return rowId
    .replace(/[^0-9a-z]/gi, '')
    .slice(0, 8)
    .toLowerCase();
}
