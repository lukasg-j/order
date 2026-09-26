import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, requireRole } from '../lib/auth-middleware';
import { getStripeClient, getStripeMode, createOrderPaymentIntent } from '../lib/stripe';
import { generateVerificationCode, verifyCode } from '../lib/verification';

export const orders = new Hono<{ Bindings: Env }>();

// --- Member: place an order -------------------------------------------------
orders.post('/', requireAuth, requireRole('member'), async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    shopId: string;
    items: { menuItemId: string; quantity: number; priceCents: number; ageRestricted: boolean }[];
    dateOfBirthConfirmed?: string; // ISO date, required if any item is age-restricted
  }>();

  const hasAgeRestrictedItem = body.items.some((i) => i.ageRestricted);
  if (hasAgeRestrictedItem && !body.dateOfBirthConfirmed) {
    return c.json({ error: 'Age confirmation required for this order' }, 400);
  }

  const subtotalCents = body.items.reduce((sum, i) => sum + i.priceCents * i.quantity, 0);
  const totalCents = subtotalCents; // TODO: + delivery fee + tax - promo discount
  const orderId = crypto.randomUUID();
  const mode = await getStripeMode(c.env);

  const stripe = getStripeClient(c.env, mode);
  const paymentIntent = await createOrderPaymentIntent({
    stripe,
    totalCents,
    currency: 'usd',
    orderId,
    mode,
  });

  await c.env.DB.prepare(
    `INSERT INTO orders (id, member_id, shop_id, items_json, subtotal_cents, total_cents, status, channel, payment_intent_id, stripe_mode, age_verification_required)
     VALUES (?, ?, ?, ?, ?, ?, 'placed', 'delivery', ?, ?, ?)`
  )
    .bind(
      orderId,
      user.sub,
      body.shopId,
      JSON.stringify(body.items),
      subtotalCents,
      totalCents,
      paymentIntent.id,
      mode,
      hasAgeRestrictedItem ? 1 : 0
    )
    .run();

  return c.json({
    orderId,
    clientSecret: paymentIntent.client_secret,
    mode,
    publishableKey: mode === 'live' ? c.env.STRIPE_PUBLISHABLE_KEY_LIVE : c.env.STRIPE_PUBLISHABLE_KEY_TEST,
  });
});

// --- Shop: accept order + generate pickup code ------------------------------
orders.post('/:orderId/ready-for-pickup', requireAuth, requireRole('shop'), async (c) => {
  const orderId = c.req.param('orderId');
  const { pin, qrPayload } = await generateVerificationCode(orderId, 'pickup', c.env.JWT_SIGNING_SECRET);

  await c.env.DB.prepare(
    `UPDATE orders SET status = 'ready_for_pickup', pickup_pin = ?, pickup_qr_payload = ? WHERE id = ?`
  )
    .bind(pin, qrPayload, orderId)
    .run();

  const trackerId = c.env.ORDER_TRACKER.idFromName(orderId);
  await c.env.ORDER_TRACKER.get(trackerId).fetch('https://do/status', {
    method: 'POST',
    body: JSON.stringify({ status: 'ready_for_pickup' }),
  });

  return c.json({ pin, qrPayload });
});

// --- Driver: verify pickup ---------------------------------------------------
orders.post('/:orderId/verify-pickup', requireAuth, requireRole('driver'), async (c) => {
  const orderId = c.req.param('orderId');
  const body = await c.req.json<{ type: 'pin' | 'qr'; value: string }>();

  const order = await c.env.DB.prepare('SELECT pickup_pin FROM orders WHERE id = ?').bind(orderId).first<{
    pickup_pin: string;
  }>();
  if (!order) return c.json({ error: 'Order not found' }, 404);

  const ok = await verifyCode({
    input: { type: body.type === 'qr' ? 'qr' : 'pin', value: body.value },
    expectedPin: order.pickup_pin,
    orderId,
    stage: 'pickup',
    secret: c.env.JWT_SIGNING_SECRET,
  });
  if (!ok) return c.json({ error: 'Verification failed' }, 400);

  await c.env.DB.prepare(`UPDATE orders SET status = 'picked_up', picked_up_at = datetime('now') WHERE id = ?`)
    .bind(orderId)
    .run();

  const trackerId = c.env.ORDER_TRACKER.idFromName(orderId);
  await c.env.ORDER_TRACKER.get(trackerId).fetch('https://do/status', {
    method: 'POST',
    body: JSON.stringify({ status: 'picked_up' }),
  });

  return c.json({ ok: true });
});

// --- Driver: verify drop-off + upload delivery photo ------------------------
orders.post('/:orderId/verify-dropoff', requireAuth, requireRole('driver'), async (c) => {
  const orderId = c.req.param('orderId');
  const body = await c.req.json<{
    type: 'pin' | 'qr';
    value: string;
    deliveryPhotoKey: string; // uploaded to R2 beforehand via a pre-signed URL
    ageVerified?: boolean;
    fallbackReason?: string; // set for photo-only/contactless proof
  }>();

  const order = await c.env.DB.prepare(
    'SELECT dropoff_pin, age_verification_required FROM orders WHERE id = ?'
  )
    .bind(orderId)
    .first<{ dropoff_pin: string; age_verification_required: number }>();
  if (!order) return c.json({ error: 'Order not found' }, 404);

  if (order.age_verification_required && !body.ageVerified) {
    return c.json({ error: 'ID verification required before completing delivery' }, 400);
  }

  if (!body.fallbackReason) {
    const ok = await verifyCode({
      input: { type: body.type === 'qr' ? 'qr' : 'pin', value: body.value },
      expectedPin: order.dropoff_pin,
      orderId,
      stage: 'dropoff',
      secret: c.env.JWT_SIGNING_SECRET,
    });
    if (!ok) return c.json({ error: 'Verification failed' }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE orders
     SET status = 'delivered', delivered_at = datetime('now'),
         delivery_photo_url = ?, delivery_proof_reason = ?,
         age_verified_at = CASE WHEN ? = 1 THEN datetime('now') ELSE age_verified_at END
     WHERE id = ?`
  )
    .bind(body.deliveryPhotoKey, body.fallbackReason ?? null, body.ageVerified ? 1 : 0, orderId)
    .run();

  const trackerId = c.env.ORDER_TRACKER.idFromName(orderId);
  await c.env.ORDER_TRACKER.get(trackerId).fetch('https://do/status', {
    method: 'POST',
    body: JSON.stringify({ status: 'delivered' }),
  });

  // TODO: enqueue payout job (shop + driver split) rather than settling inline
  // await c.env.WEBHOOK_QUEUE.send({ type: 'trigger_payout', orderId });

  return c.json({ ok: true });
});

// --- Member/Shop/Driver: WebSocket subscribe to live order updates ---------
orders.get('/:orderId/live', requireAuth, async (c) => {
  const orderId = c.req.param('orderId');
  const trackerId = c.env.ORDER_TRACKER.idFromName(orderId);
  return c.env.ORDER_TRACKER.get(trackerId).fetch(new Request('https://do/ws', c.req.raw));
});
