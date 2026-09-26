import Stripe from 'stripe';
import type { Env } from '../types';

// Workers run on the V8 isolate runtime, not Node — Stripe's default HTTP
// client relies on Node's `http` module, so it must be swapped for the
// fetch-based client. This must be done for every Stripe instance.

export type StripeMode = 'test' | 'live';

export async function getStripeMode(env: Env): Promise<StripeMode> {
  const flag = await env.CONFIG_KV.get('stripe_mode');
  return flag === 'live' ? 'live' : 'test'; // default safely to test
}

export function getStripeClient(env: Env, mode: StripeMode): Stripe {
  const secretKey = mode === 'live' ? env.STRIPE_SECRET_KEY_LIVE : env.STRIPE_SECRET_KEY_TEST;
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: '2024-06-20',
  });
}

export function getWebhookSecret(env: Env, mode: StripeMode): string {
  return mode === 'live' ? env.STRIPE_WEBHOOK_SECRET_LIVE : env.STRIPE_WEBHOOK_SECRET_TEST;
}

/**
 * Verifies a Stripe webhook signature using the async/WebCrypto-compatible
 * verifier — Workers lack Node's `crypto`, so `constructEvent` (sync) will
 * throw; `constructEventAsync` is required here.
 */
export async function verifyWebhookSignature(
  stripe: Stripe,
  rawBody: string,
  signature: string,
  webhookSecret: string
): Promise<Stripe.Event> {
  return stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
}

/**
 * Creates a single PaymentIntent for the full order total. The platform
 * takes its commission and the remainder is later split to shop + driver
 * via separate Connect transfers processed by the payout queue consumer,
 * rather than doing multi-party transfer_data at intent-creation time —
 * this keeps the initial charge simple and makes retries/refunds easier
 * to reason about.
 */
export async function createOrderPaymentIntent(params: {
  stripe: Stripe;
  totalCents: number;
  currency: string;
  memberStripeCustomerId?: string;
  orderId: string;
  mode: StripeMode;
}): Promise<Stripe.PaymentIntent> {
  const { stripe, totalCents, currency, memberStripeCustomerId, orderId, mode } = params;
  return stripe.paymentIntents.create({
    amount: totalCents,
    currency,
    customer: memberStripeCustomerId,
    metadata: { orderId, mode },
    automatic_payment_methods: { enabled: true },
  });
}
