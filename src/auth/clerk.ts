import {
  createPublicKey,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

// Clerk session tokens are RS256 JWTs signed with the instance's keys. This is
// the check the Go server gets from clerk-sdk-go, done by hand with node:crypto
// so no extra dependency is needed: fetch the instance's JWKS from Clerk's
// Backend API, verify the signature with the key the token names, then the
// expiry. The keys are cached and refetched only when a token names one we
// haven't seen (Clerk rotated them).

const CLERK_API = 'https://api.clerk.com/v1';
// Same leeway as the Go server: tolerates a little clock skew either way.
const LEEWAY_SECONDS = 30;

type Jwk = JsonWebKey & { kid?: string };

export class ClerkClient {
  private keys = new Map<string, KeyObject>();

  constructor(private readonly secretKey: string) {}

  // Returns the Clerk user id (the token's sub) or throws an Error saying why
  // the token was refused.
  async verifySessionToken(token: string): Promise<string> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('not a JWT');
    const [headerPart, payloadPart, signaturePart] = parts;

    const header = decodeJson(headerPart) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);
    if (!header.kid) throw new Error('token has no kid');

    const key = await this.key(header.kid);
    const signed = verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      key,
      Buffer.from(signaturePart, 'base64url'),
    );
    if (!signed) throw new Error('bad signature');

    const claims = decodeJson(payloadPart) as {
      sub?: string;
      exp?: number;
      nbf?: number;
    };
    const now = Date.now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_SECONDS < now) {
      throw new Error('token expired');
    }
    if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_SECONDS > now) {
      throw new Error('token not valid yet');
    }
    if (!claims.sub) throw new Error('token has no subject');
    return claims.sub;
  }

  // The Clerk user, in the same shape the webhook delivers it.
  async getUser(clerkId: string): Promise<{
    id?: string;
    email_addresses?: { id?: string; email_address?: string }[];
    primary_email_address_id?: string;
    username?: string | null;
  }> {
    return this.get(`/users/${encodeURIComponent(clerkId)}`);
  }

  private async key(kid: string): Promise<KeyObject> {
    let key = this.keys.get(kid);
    if (key) return key;

    const jwks = await this.get<{ keys?: Jwk[] }>('/jwks');
    this.keys = new Map(
      (jwks.keys ?? [])
        .filter((jwk) => jwk.kid)
        .map((jwk) => [jwk.kid!, createPublicKey({ key: jwk, format: 'jwk' })]),
    );
    key = this.keys.get(kid);
    if (!key) throw new Error(`unknown signing key ${kid}`);
    return key;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${CLERK_API}${path}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    if (!response.ok) {
      throw new Error(`clerk GET ${path}: ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new Error('undecodable token');
  }
}
