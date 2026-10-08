// SQLite via Node's built-in driver. Double bookings are blocked by triggers,
// so no code path (UI, API, import, admin edit) can create an overlapping allocation.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const ACTIVE = `('hold','pending','confirmed','active','maintenance')`;
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, placeholder INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, role TEXT NOT NULL CHECK (role IN ('admin','office','yard','finance','customer')),
  password_hash TEXT, customer_id INTEGER, totp_enabled INTEGER DEFAULT 0, created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, kind TEXT DEFAULT 'individual' CHECK (kind IN ('individual','company')),
  name TEXT NOT NULL, company TEXT, email TEXT, phone TEXT, address TEXT, billing_address TEXT, abn TEXT,
  id_notes TEXT, source TEXT, tags TEXT, notes TEXT, created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS boats (
  id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), name TEXT, type TEXT, make_model TEXT,
  length_m REAL NOT NULL, hin TEXT, rego TEXT, engine TEXT, trailer INTEGER DEFAULT 0, trailer_details TEXT,
  insurer TEXT, insurance_policy TEXT, insurance_expiry TEXT, photo TEXT, docs TEXT DEFAULT '[]', qr_token TEXT UNIQUE,
  created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS bays (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, zone TEXT, max_length_m REAL NOT NULL,
  status TEXT DEFAULT 'available' CHECK (status IN ('available','occupied','reserved','maintenance','out_of_service')), notes TEXT);

CREATE TABLE IF NOT EXISTS rates (
  id INTEGER PRIMARY KEY, min_len REAL NOT NULL, max_len REAL NOT NULL,
  package TEXT NOT NULL CHECK (package IN ('standard','unlimited')), term TEXT NOT NULL CHECK (term IN ('annual','monthly')),
  monthly_rate REAL NOT NULL, placeholder INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), name TEXT, email TEXT, phone TEXT,
  service TEXT DEFAULT 'storage', source TEXT DEFAULT 'website', stage TEXT DEFAULT 'new'
    CHECK (stage IN ('new','contacted','quoted','deposit_pending','booked','lost')),
  lost_reason TEXT, message TEXT, quote_json TEXT, assigned_to INTEGER, created_at TEXT DEFAULT (${NOW}), updated_at TEXT);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, kind TEXT DEFAULT 'storage' CHECK (kind IN ('storage','maintenance')),
  bay_id INTEGER NOT NULL REFERENCES bays(id), customer_id INTEGER REFERENCES customers(id), boat_id INTEGER REFERENCES boats(id),
  lead_id INTEGER, package TEXT, term TEXT, monthly_rate REAL,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('hold','pending','confirmed','active','maintenance','completed','cancelled','expired')),
  hold_expires_at TEXT, pending_expires_at TEXT, deposit_amount REAL, deposit_paid INTEGER DEFAULT 0,
  stripe_session_id TEXT, notes TEXT, created_by INTEGER, created_at TEXT DEFAULT (${NOW}),
  CHECK (end_date > start_date));

CREATE TRIGGER IF NOT EXISTS bookings_no_overlap_ins BEFORE INSERT ON bookings
WHEN NEW.status IN ${ACTIVE}
BEGIN
  SELECT RAISE(ABORT, 'DOUBLE_BOOKING') WHERE EXISTS (
    SELECT 1 FROM bookings b WHERE b.bay_id = NEW.bay_id
      AND b.status IN ${ACTIVE}
      AND (b.status <> 'hold' OR b.hold_expires_at > ${NOW})
      AND b.start_date < NEW.end_date AND NEW.start_date < b.end_date);
END;

CREATE TRIGGER IF NOT EXISTS bookings_no_overlap_upd BEFORE UPDATE OF bay_id, start_date, end_date, status ON bookings
WHEN NEW.status IN ${ACTIVE}
BEGIN
  SELECT RAISE(ABORT, 'DOUBLE_BOOKING') WHERE EXISTS (
    SELECT 1 FROM bookings b WHERE b.bay_id = NEW.bay_id AND b.id <> NEW.id
      AND b.status IN ${ACTIVE}
      AND (b.status <> 'hold' OR b.hold_expires_at > ${NOW})
      AND b.start_date < NEW.end_date AND NEW.start_date < b.end_date);
END;

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY, booking_id INTEGER REFERENCES bookings(id), customer_id INTEGER REFERENCES customers(id),
  term TEXT, package TEXT, monthly_rate REAL, start_date TEXT, end_date TEXT, tc_version TEXT, tc_accepted_at TEXT,
  status TEXT DEFAULT 'active', created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, number TEXT UNIQUE, customer_id INTEGER REFERENCES customers(id), booking_id INTEGER,
  period TEXT, issue_date TEXT, due_date TEXT, subtotal_ex REAL, gst REAL, total REAL, paid REAL DEFAULT 0,
  status TEXT DEFAULT 'issued' CHECK (status IN ('draft','issued','paid','overdue','void')), kind TEXT DEFAULT 'storage',
  created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY, invoice_id INTEGER REFERENCES invoices(id), description TEXT, category TEXT, billing TEXT,
  qty REAL DEFAULT 1, unit_inc REAL, amount_inc REAL, gst REAL);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, customer_id INTEGER, booking_id INTEGER, invoice_id INTEGER, amount REAL NOT NULL,
  method TEXT CHECK (method IN ('stripe','bank_transfer','card_phone','cash')), reference TEXT, paid_on TEXT,
  kind TEXT DEFAULT 'invoice', reconciled INTEGER DEFAULT 0, recorded_by INTEGER, created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS extras (
  id INTEGER PRIMARY KEY, booking_id INTEGER, customer_id INTEGER, date TEXT, description TEXT, category TEXT,
  amount_inc REAL, invoice_id INTEGER, source_type TEXT, source_id INTEGER);

CREATE TABLE IF NOT EXISTS lifts (
  id INTEGER PRIMARY KEY, booking_id INTEGER REFERENCES bookings(id), boat_id INTEGER, date TEXT NOT NULL, slot TEXT NOT NULL,
  status TEXT DEFAULT 'booked' CHECK (status IN ('booked','done','cancelled','no_show')), is_extra INTEGER DEFAULT 0,
  transfer INTEGER DEFAULT 1, wash INTEGER DEFAULT 1, engine_flush INTEGER DEFAULT 0, notes TEXT,
  booked_via TEXT DEFAULT 'staff', created_by INTEGER, created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS checklist_templates (
  id INTEGER PRIMARY KEY, name TEXT, type TEXT CHECK (type IN ('checkin','release','return')), items TEXT, active INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS checklists (
  id INTEGER PRIMARY KEY, type TEXT, template_id INTEGER, boat_id INTEGER REFERENCES boats(id), booking_id INTEGER, customer_id INTEGER,
  staff_id INTEGER, results TEXT, inventory TEXT, fuel_level TEXT, damage_notes TEXT, photos TEXT DEFAULT '[]',
  signature TEXT, signed_name TEXT, released_to TEXT, release_id INTEGER, created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS service_jobs (
  id INTEGER PRIMARY KEY, customer_id INTEGER, boat_id INTEGER, service TEXT, description TEXT, quote_amount REAL,
  scheduled_date TEXT, assigned_to INTEGER, parts TEXT, parts_cost REAL DEFAULT 0, labour_hours REAL DEFAULT 0, labour_rate REAL DEFAULT 0,
  status TEXT DEFAULT 'quoted' CHECK (status IN ('quoted','scheduled','in_progress','done','invoiced','cancelled')),
  photos TEXT DEFAULT '[]', created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY, name TEXT, type TEXT CHECK (type IN ('bay','equipment','facility')), bay_id INTEGER, notes TEXT);

CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id INTEGER PRIMARY KEY, asset_id INTEGER REFERENCES assets(id), title TEXT, kind TEXT CHECK (kind IN ('scheduled','reactive')),
  due_date TEXT, recur_days INTEGER, status TEXT DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
  assigned_to INTEGER, notes TEXT, cost REAL, block_booking_id INTEGER, completed_at TEXT, created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, date TEXT, category TEXT, supplier TEXT, description TEXT, amount_inc REAL, gst REAL, receipt TEXT,
  created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, rego TEXT, hin TEXT, reason TEXT, evidence TEXT,
  added_by INTEGER, created_at TEXT DEFAULT (${NOW}), updated_at TEXT);

CREATE TABLE IF NOT EXISTS watch_alerts (
  id INTEGER PRIMARY KEY, watch_id INTEGER, entity TEXT, entity_id INTEGER, detail TEXT, resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS communications (
  id INTEGER PRIMARY KEY, customer_id INTEGER, lead_id INTEGER, channel TEXT, direction TEXT, summary TEXT, user_id INTEGER,
  created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS email_templates (key TEXT PRIMARY KEY, subject TEXT, body TEXT);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, channel TEXT DEFAULT 'email', recipient TEXT, subject TEXT, body TEXT, template TEXT,
  dedupe_key TEXT UNIQUE, customer_id INTEGER, created_at TEXT DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT, action TEXT, entity TEXT, entity_id INTEGER, reason TEXT,
  detail TEXT, at TEXT DEFAULT (${NOW}));

-- Phase 2 hooks: GPS trackers, fuel sensors, RFID, Messenger, Xero/MYOB, SMS.
CREATE TABLE IF NOT EXISTS integrations (id INTEGER PRIMARY KEY, provider TEXT, kind TEXT, config TEXT, enabled INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY, boat_id INTEGER, kind TEXT CHECK (kind IN ('gps','fuel','rfid')), external_id TEXT,
  integration_id INTEGER, last_reading TEXT, last_seen_at TEXT);
`;

function open(file) {
  const f = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'cockatoo.db');
  if (f !== ':memory:') fs.mkdirSync(path.dirname(f), { recursive: true });
  const db = new DatabaseSync(f);
  db.exec(SCHEMA);
  return db;
}

// Small helpers so route code stays readable.
function helpers(db) {
  return {
    db,
    all: (sql, ...p) => db.prepare(sql).all(...p),
    get: (sql, ...p) => db.prepare(sql).get(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    setting(key, fallback) {
      const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
      return r ? r.value : fallback;
    },
  };
}

module.exports = { open, helpers };
