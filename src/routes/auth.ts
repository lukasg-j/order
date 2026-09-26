import { Hono } from 'hono';
import type { Env } from '../types';
import { signJwt } from '../lib/jwt';

export const auth = new Hono<{ Bindings: Env }>();

// NOTE: password hashing shown here uses WebCrypto PBKDF2 as a Workers-native
// baseline. For production, evaluate a dedicated password-hashing approach
// (e.g. an external auth provider, or a Worker-compatible bcrypt/argon2 build)
// against your threat model before launch.
async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

auth.post('/signup', async (c) => {
  const body = await c.req.json<{
    role: 'shop' | 'driver' | 'member';
    name: string;
    email: string;
    password: string;
    dateOfBirth?: string;
  }>();

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = `${btoa(String.fromCharCode(...salt))}:${await hashPassword(body.password, salt)}`;
  const userId = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO users (id, role, name, email, password_hash, date_of_birth) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, body.role, body.name, body.email, passwordHash, body.dateOfBirth ?? null)
    .run();

  const token = await signJwt(
    { sub: userId, role: body.role, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 },
    c.env.JWT_SIGNING_SECRET
  );

  return c.json({ token, userId });
});

auth.post('/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();

  const user = await c.env.DB.prepare('SELECT id, role, password_hash, status FROM users WHERE email = ?')
    .bind(body.email)
    .first<{ id: string; role: 'admin' | 'shop' | 'driver' | 'member'; password_hash: string; status: string }>();

  if (!user || user.status !== 'active') return c.json({ error: 'Invalid credentials' }, 401);

  const [saltB64, expectedHash] = user.password_hash.split(':');
  const salt = Uint8Array.from(atob(saltB64), (ch) => ch.charCodeAt(0));
  const actualHash = await hashPassword(body.password, salt);
  if (actualHash !== expectedHash) return c.json({ error: 'Invalid credentials' }, 401);

  const token = await signJwt(
    { sub: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 },
    c.env.JWT_SIGNING_SECRET
  );

  return c.json({ token, role: user.role });
});
