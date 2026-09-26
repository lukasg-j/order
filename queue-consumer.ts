import type Stripe from 'stripe';
import type { Env } from './types';

interface WebhookQueueMessage {
  event: Stripe.Event;
  mode: 'test' | 'live';
}

export async function handleQueueBatch(batch: MessageBatch<WebhookQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processEvent(message.body, env);
      message.ack();
    } catch (err) {
      console.error('Webhook processing failed', message.body.event.id, err);
      message.retry(); // Cloudflare Queues will retry per max_retries, then send to DLQ
    }
  }
}

async function processEvent({ event, mode }: WebhookQueueMessage, env: Env): Promise<void> {
  // Idempotency: skip if we've already recorded this event id.
  const existing = await env.DB.prepare('SELECT id FROM transactions WHERE stripe_event_id = ?')
    .bind(event.id)
    .first();
  if (existing) return;

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intent = event.data.object as Stripe.PaymentIntent;
      const orderId = intent.metadata.orderId;
      // TODO: look up commission rate, compute split, insert transaction row,
      // enqueue a separate payout job for shop + driver Connect transfers.
      await env.DB.prepare(
        `INSERT INTO transactions (id, order_id, amount_cents, platform_fee_cents, shop_payout_cents, driver_payout_cents, stripe_mode, payment_method, status, stripe_event_id)
         VALUES (?, ?, ?, 0, 0, 0, ?, 'card', 'succeeded', ?)`
      )
        .bind(crypto.randomUUID(), orderId, intent.amount, mode, event.id)
        .run();
      break;
    }

    case 'payment_intent.payment_failed': {
      const intent = event.data.object as Stripe.PaymentIntent;
      await env.DB.prepare(`UPDATE orders SET status = 'cancelled' WHERE payment_intent_id = ?`)
        .bind(intent.id)
        .run();
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      await env.DB.prepare(`UPDATE orders SET status = 'refunded' WHERE payment_intent_id = ?`)
        .bind(charge.payment_intent as string)
        .run();
      break;
    }

    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      const status = account.charges_enabled ? 'complete' : 'pending';
      await env.DB.prepare(`UPDATE shops SET stripe_onboarding_status = ? WHERE stripe_account_id = ?`)
        .bind(status, account.id)
        .run();
      await env.DB.prepare(`UPDATE drivers SET stripe_onboarding_status = ? WHERE stripe_account_id = ?`)
        .bind(status, account.id)
        .run();
      break;
    }

    default:
      // Unhandled event types are fine to ignore — Stripe sends many more
      // than a given integration needs.
      break;
  }
}
