PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pickup_orders (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL CHECK (length(trim(first_name)) BETWEEN 1 AND 100),
  last_name TEXT NOT NULL CHECK (length(trim(last_name)) BETWEEN 1 AND 100),
  street TEXT NOT NULL CHECK (length(trim(street)) BETWEEN 1 AND 200),
  zip_code TEXT NOT NULL CHECK (length(zip_code) = 5 AND zip_code NOT GLOB '*[^0-9]*'),
  phone TEXT NOT NULL CHECK (length(trim(phone)) BETWEEN 6 AND 32),
  iban TEXT CHECK (iban IS NULL OR length(iban) BETWEEN 15 AND 34),
  pickup_time_slot TEXT NOT NULL CHECK (
    pickup_time_slot IN (
      '10:00-11:00', '11:00-12:00', '12:00-13:00', '13:00-14:00',
      '14:00-15:00', '15:00-16:00', '16:00-17:00', '17:00-18:00', '18:00-19:00'
    )
  ),
  idempotency_key TEXT,
  request_hash TEXT,
  assigned_driver_id TEXT,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  total_refund NUMERIC NOT NULL CHECK (total_refund > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pickup_order_items (
  order_id TEXT NOT NULL REFERENCES pickup_orders(id) ON DELETE CASCADE,
  bottle_type TEXT NOT NULL CHECK (bottle_type IN ('pet', 'beer', 'water', 'can')),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  unit_refund NUMERIC NOT NULL CHECK (
    (bottle_type = 'beer' AND unit_refund = 0.08) OR
    (bottle_type = 'water' AND unit_refund = 0.15) OR
    (bottle_type IN ('pet', 'can') AND unit_refund = 0.25)
  ),
  PRIMARY KEY (order_id, bottle_type)
);

CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  username TEXT,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('cargo-bike', 'bike', 'car')),
  token_hash TEXT NOT NULL UNIQUE,
  online INTEGER NOT NULL DEFAULT 0 CHECK (online IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS driver_order_offers (
  driver_id TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES pickup_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'expired', 'unavailable')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  missed_at TEXT,
  PRIMARY KEY (driver_id, order_id)
);

CREATE INDEX IF NOT EXISTS driver_order_offers_pending
  ON driver_order_offers(driver_id, status, expires_at);
