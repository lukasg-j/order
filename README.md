# Food Delivery Marketplace — Cloudflare Edge Scaffold

This is a **starting architecture**, not a finished product. It implements the
patterns that are easy to get wrong on Workers, and stubs the rest with
clear `TODO`s. Expect several more weeks of work to reach the full spec
(role dashboards, Mini POS, PWA frontend, analytics, admin panel, mobile
apps, Connect payout splitting).

## What's implemented
- **Auth**: signup/login issuing HS256 JWTs signed with WebCrypto (`src/lib/jwt.ts`), role-based middleware (`src/lib/auth-middleware.ts`)
- **D1 schema**: all core tables from the spec (`src/db/schema.sql`)
- **Stripe**: fetch-based client, test/live mode switched via a KV flag, PaymentIntent creation, async webhook signature verification (`src/lib/stripe.ts`)
- **Webhook → Queue flow**: signature verified synchronously, event handed to a Queue for idempotent processing (`src/routes/stripe-webhook.ts`, `src/queue-consumer.ts`)
- **Pickup/drop-off verification**: HMAC-signed PIN + QR codes (`src/lib/verification.ts`), wired into the order routes
- **Durable Objects**: `OrderTracker` (per-order WebSocket broadcast for status + driver GPS) and `DriverPresence` (per-driver online/offline + delivery offers)
- **Cron**: stale-order cleanup and a payout-reconciliation stub, both registered in `wrangler.toml`

## What's stubbed (`TODO`s in code)
- Admin routes: shop/driver approval, commission config, dispute handling, analytics
- Shop routes: menu CRUD, delivery zones, Connect onboarding
- Driver routes: Connect onboarding, earnings, dispatch matching logic
- Mini POS routes and Stripe Terminal integration
- R2 pre-signed upload URLs for photos/ID docs
- Actual Connect transfer splitting (platform fee / shop payout / driver payout)
- Web Push notification sending
- Frontend (React/Vite PWA) and mobile apps — this repo is API-only

## Setup
```bash
npm install
wrangler d1 create food-delivery-db        # then paste the id into wrangler.toml
wrangler kv namespace create CONFIG_KV     # then paste the id into wrangler.toml
wrangler r2 bucket create food-delivery-photos
wrangler queues create stripe-webhook-events
wrangler queues create stripe-webhook-dlq

wrangler secret put JWT_SIGNING_SECRET
wrangler secret put STRIPE_SECRET_KEY_TEST
wrangler secret put STRIPE_PUBLISHABLE_KEY_TEST
wrangler secret put STRIPE_WEBHOOK_SECRET_TEST
# repeat _LIVE variants before going to production

npm run db:migrate:local
npm run dev
```

Set the initial mode in KV so requests default to test mode:
```bash
wrangler kv key put --binding=CONFIG_KV stripe_mode test
```

## Suggested build order
1. Admin approval flow + shop/driver Connect onboarding (nothing else works without approved, payable shops/drivers)
2. Menu CRUD + R2 image upload
3. Checkout → PaymentIntent → order lifecycle (mostly done here)
4. Driver dispatch matching (who gets the delivery offer — this scaffold pushes to one driver's `DriverPresence` DO; you'll want a matching/broadcast strategy)
5. Frontend PWA against the API
6. Mini POS, analytics, payout reconciliation

Given the size of this project, working through it inside **Claude Code**
(desktop or terminal) will go a lot better than one-shot chat generation —
you can iterate file-by-file, run `wrangler dev` locally, and keep context
across many sessions as the codebase grows.
