import type { Context, Next } from 'hono';
import { verifyJwt, type JwtPayload } from './jwt';
import type { Env } from '../types';

declare module 'hono' {
  interface ContextVariableMap {
    user: JwtPayload;
  }
}

export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return c.json({ error: 'Missing bearer token' }, 401);

  const payload = await verifyJwt(token, c.env.JWT_SIGNING_SECRET);
  if (!payload) return c.json({ error: 'Invalid or expired token' }, 401);

  c.set('user', payload);
  await next();
}

export function requireRole(...roles: JwtPayload['role'][]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const user = c.get('user');
    if (!roles.includes(user.role)) {
      return c.json({ error: 'Forbidden for this role' }, 403);
    }
    await next();
  };
}
