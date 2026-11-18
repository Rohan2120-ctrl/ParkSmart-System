-- TaxiBook India — SQLite 3 Relational Database Schema
-- Engine: SQLite 3 (via C backend server.c)

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. Authenticated Rider Accounts
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  default_phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'rider' CHECK (role IN ('rider')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 2. Authenticated Session Tokens
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Persistent Taxi Bookings & Dispatch Ledger
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  booking_code TEXT NOT NULL UNIQUE,
  passenger_name TEXT NOT NULL,
  passenger_phone TEXT NOT NULL,
  vehicle TEXT NOT NULL CHECK (vehicle IN ('bike', 'auto', 'car')),
  pickup_lat REAL NOT NULL,
  pickup_lng REAL NOT NULL,
  pickup_label TEXT NOT NULL,
  dest_lat REAL NOT NULL,
  dest_lng REAL NOT NULL,
  dest_label TEXT NOT NULL,
  distance_km REAL NOT NULL,
  duration_min REAL NOT NULL,
  base_fare REAL NOT NULL,
  per_km_rate REAL NOT NULL,
  fare_inr REAL NOT NULL,
  driver_name TEXT NOT NULL,
  driver_phone TEXT NOT NULL,
  plate_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for fast owner-scoped lookups
CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
