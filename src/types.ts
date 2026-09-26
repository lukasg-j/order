export interface Env {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  // PHOTOS: R2Bucket; // add back when photo uploads are built
  ORDER_TRACKER: DurableObjectNamespace;
  DRIVER_PRESENCE: DurableObjectNamespace;
  WEBHOOK_QUEUE: Queue;

  JWT_SIGNING_SECRET: string;
  STRIPE_SECRET_KEY_TEST: string;
  STRIPE_SECRET_KEY_LIVE: string;
  STRIPE_PUBLISHABLE_KEY_TEST: string;
  STRIPE_PUBLISHABLE_KEY_LIVE: string;
  STRIPE_WEBHOOK_SECRET_TEST: string;
  STRIPE_WEBHOOK_SECRET_LIVE: string;
}
