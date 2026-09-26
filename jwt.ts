// Minimal HS256 JWT using WebCrypto — Workers don't ship Node's `crypto` module,
// so this is the pattern for auth tokens instead of a Node-oriented JWT library.

export interface JwtPayload {
  sub: string;       // user id
  role: 'admin' | 'shop' | 'driver' | 'member';
  exp: number;        // unix seconds
  [key: string]: unknown;
}

function base64UrlEncode(data: ArrayBuffer | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await getKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const key = await getKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlDecode(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!valid) return null;

  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as JwtPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expired

  return payload;
}
