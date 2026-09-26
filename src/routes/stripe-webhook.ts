import { Hono } from 'hono';
import type { Env } from '../types';
import { getStripeClient, getStripeMode, getWebhookSecret, verifyWebhookSignature } from '../lib/stripe';

export const stripeWebhook = new Hono<{ Bindings: Env }>();

// Stripe requires a fast response (a few seconds) or it will retry the
// webhook. So: verify the signature (cheap), then hand the event off to a
// Queue and return 200 immediately. All the actual business logic —
// updating D1, triggering payouts, notifying users — happens in the queue
// consumer (see queue-consumer.ts), where retries are safe and don't risk
// Stripe re-sending the same event because we took too long.
stripeWebhook.post('/', async (c) => {
  const mode = await getStripeMode(c.env);
  const stripe = getStripeClient(c.env, mode);
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ error: 'Missing signature' }, 400);

  const rawBody = await c.req.text();

  let event;
  try {
    event = await verifyWebhookSignature(stripe, rawBody, signature, getWebhookSecret(c.env, mode));
  } catch (err) {
    return c.json({ error: `Signature verification failed: ${(err as Error).message}` }, 400);
  }

  await c.env.WEBHOOK_QUEUE.send({ event, mode });

  return c.json({ received: true });
});
