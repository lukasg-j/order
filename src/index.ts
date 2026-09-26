import { Hono } from 'hono';
import type { Env } from './types';
import { auth } from './routes/auth';
import { orders } from './routes/orders';
import { stripeWebhook } from './routes/stripe-webhook';
import { handleQueueBatch } from './queue-consumer';

export { OrderTracker } from './durable-objects/OrderTracker';
export { DriverPresence } from './durable-objects/DriverPresence';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

app.route('/auth', auth);
app.route('/orders', orders);
app.route('/webhooks/stripe', stripeWebhook);

// TODO: mount remaining route groups as they're built out:
// app.route('/admin', admin);       // approvals, commission config, stripe_mode toggle, disputes
// app.route('/shops', shops);       // menu CRUD, hours, delivery zones, Connect onboarding
// app.route('/drivers', drivers);   // Connect onboarding, availability, earnings
// app.route('/pos', pos);           // Mini POS: walk-in orders, Terminal payments
// app.route('/uploads', uploads);   // pre-signed R2 upload URLs for photos/docs

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleQueueBatch(batch as any, env);
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // Two crons are registered in wrangler.toml: */15 min (stale-order
    // cleanup) and daily at 03:00 (payout reconciliation). Distinguish them
    // by the cron expression that triggered this invocation.
    if (event.cron === '*/15 * * * *') {
      await cleanupStaleOrders(env);
    } else if (event.cron === '0 3 * * *') {
      await reconcilePayouts(env);
    }
  },
};

async function cleanupStaleOrders(env: Env): Promise<void> {
  // Orders stuck in 'placed' with no shop acceptance for >30 min get
  // cancelled and (TODO) refunded via Stripe.
  await env.DB.prepare(
    `UPDATE orders SET status = 'cancelled'
     WHERE status = 'placed' AND created_at < datetime('now', '-30 minutes')`
  ).run();
}

async function reconcilePayouts(env: Env): Promise<void> {
  // TODO: sum up succeeded transactions since last reconciliation, verify
  // against Stripe Connect transfer records, flag mismatches for admin review.
}
