-- Core relational schema for the marketplace. Ephemeral/high-frequency data
-- (live GPS pings, WebSocket session state) intentionally lives in Durable
-- Object storage instead, NOT here.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','shop','driver','member')),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  date_of_birth TEXT,          -- for age verification at checkout
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL,
  lng REAL,
  stripe_account_id TEXT,
  stripe_onboarding_status TEXT DEFAULT 'pending' CHECK (stripe_onboarding_status IN ('pending','complete','restricted')),
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','rejected','suspended')),
  delivery_zone_geojson TEXT,  -- polygon for delivery radius
  operating_hours TEXT,        -- JSON: {"mon":["09:00","21:00"], ...}
  commission_rate_bps INTEGER, -- overrides platform default if set; NULL = use platform default
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  category TEXT,
  available INTEGER NOT NULL DEFAULT 1,   -- boolean
  age_restricted INTEGER NOT NULL DEFAULT 0,
  min_age INTEGER,                        -- e.g. 18 or 21, per jurisdiction
  image_url TEXT,                         -- R2 object key
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_menu_items_shop ON menu_items(shop_id);

CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  vehicle_info TEXT,           -- JSON: {"make":..,"model":..,"plate":..}
  license_doc_url TEXT,        -- R2 object key
  stripe_account_id TEXT,
  stripe_onboarding_status TEXT DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','rejected','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES users(id),
  shop_id TEXT NOT NULL REFERENCES shops(id),
  driver_id TEXT REFERENCES drivers(id),
  items_json TEXT NOT NULL,     -- snapshot of ordered items at time of purchase
  subtotal_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed' CHECK (status IN (
    'placed','accepted','preparing','ready_for_pickup',
    'picked_up','en_route','delivered','cancelled','refunded'
  )),
  channel TEXT NOT NULL DEFAULT 'delivery' CHECK (channel IN ('delivery','pos')),
  payment_intent_id TEXT,
  stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('test','live')),
  pickup_pin TEXT,               -- short human-enterable code
  pickup_qr_payload TEXT,        -- HMAC-signed JSON, see lib/verification.ts
  dropoff_pin TEXT,
  dropoff_qr_payload TEXT,
  delivery_photo_url TEXT,       -- R2 object key
  delivery_proof_reason TEXT,    -- set when photo-only / contactless fallback used
  age_verification_required INTEGER NOT NULL DEFAULT 0,
  age_verified_at TEXT,
  picked_up_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_member ON orders(member_id);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  shop_payout_cents INTEGER NOT NULL,
  driver_payout_cents INTEGER NOT NULL,
  stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('test','live')),
  payment_method TEXT,          -- card, wallet, cash, terminal
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','refunded')),
  stripe_event_id TEXT,         -- idempotency / audit trail back to webhook event
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transactions_order ON transactions(order_id);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('shop','driver')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL,
  keys_json TEXT NOT NULL,      -- {p256dh, auth} from Web Push subscription
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO platform_config (key, value) VALUES ('default_commission_bps', '1500'); -- 15%
