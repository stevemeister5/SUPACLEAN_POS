/**
 * Core POS schema (PostgreSQL): creates the 18 foundational tables that live
 * only in init.js (SQLite, never loaded in production) plus the columns and
 * constraints routes reference. Idempotent - safe to run on every boot.
 * Must load BEFORE all other ensure*.js files in server/index.js.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

const TABLES = [
`CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL,
  branch_type TEXT NOT NULL, address TEXT, phone TEXT, manager_name TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
  address TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  sms_notifications_enabled INTEGER DEFAULT 1, tags TEXT,
  primary_branch_id INTEGER, phone_normalized TEXT,
  billing_type TEXT DEFAULT 'per_order', company_name TEXT, tax_id TEXT,
  billing_address TEXT, billing_contact_name TEXT, billing_contact_phone TEXT,
  billing_contact_email TEXT, tin TEXT, vrn TEXT
)`,
`CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  base_price DOUBLE PRECISION DEFAULT 0 NOT NULL,
  price_per_item DOUBLE PRECISION DEFAULT 0, price_per_kg DOUBLE PRECISION DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY, receipt_number TEXT NOT NULL,
  customer_id INTEGER NOT NULL, service_id INTEGER NOT NULL,
  garment_type TEXT, color TEXT, quantity INTEGER DEFAULT 1,
  weight_kg DOUBLE PRECISION, special_instructions TEXT,
  delivery_type TEXT DEFAULT 'standard',
  express_surcharge_multiplier DOUBLE PRECISION DEFAULT 0,
  status TEXT DEFAULT 'pending', total_amount DOUBLE PRECISION NOT NULL,
  paid_amount DOUBLE PRECISION DEFAULT 0, payment_status TEXT DEFAULT 'not_paid',
  payment_method TEXT DEFAULT 'cash',
  order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ready_date TIMESTAMP, collected_date TIMESTAMP, created_by TEXT,
  is_voided BOOLEAN DEFAULT FALSE, void_reason TEXT, voided_by TEXT, voided_at TIMESTAMP,
  archived_at TIMESTAMP, archived_by TEXT, archive_reason TEXT,
  estimated_collection_date TIMESTAMP, collected_at_branch_id INTEGER,
  created_at_branch_id INTEGER, ready_at_branch_id INTEGER,
  branch_id INTEGER, item_id INTEGER
)`,
`CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY, setting_key TEXT NOT NULL, setting_value TEXT NOT NULL,
  description TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY, order_id INTEGER, transaction_type TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL, payment_method TEXT DEFAULT 'cash',
  description TEXT, transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT, branch_id INTEGER, is_voided BOOLEAN DEFAULT FALSE,
  void_reason TEXT, voided_by TEXT, voided_at TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS daily_cash_summaries (
  id SERIAL PRIMARY KEY, date DATE NOT NULL,
  opening_balance DOUBLE PRECISION DEFAULT 0, cash_sales DOUBLE PRECISION DEFAULT 0,
  book_sales DOUBLE PRECISION DEFAULT 0, card_sales DOUBLE PRECISION DEFAULT 0,
  mobile_money_sales DOUBLE PRECISION DEFAULT 0, credit_sales DOUBLE PRECISION DEFAULT 0,
  bank_deposits DOUBLE PRECISION DEFAULT 0, bank_payments DOUBLE PRECISION DEFAULT 0,
  mpesa_received DOUBLE PRECISION DEFAULT 0, mpesa_paid DOUBLE PRECISION DEFAULT 0,
  expenses_from_cash DOUBLE PRECISION DEFAULT 0, expenses_from_bank DOUBLE PRECISION DEFAULT 0,
  expenses_from_mpesa DOUBLE PRECISION DEFAULT 0, cash_in_hand DOUBLE PRECISION DEFAULT 0,
  closing_balance DOUBLE PRECISION DEFAULT 0, is_reconciled BOOLEAN DEFAULT FALSE,
  reconciled_by TEXT, reconciled_at TIMESTAMP, notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  branch_id INTEGER, reconciled_closing_balance DOUBLE PRECISION,
  opening_cash_declared NUMERIC(14,2), opening_variance NUMERIC(14,2) DEFAULT 0 NOT NULL,
  opening_session_by TEXT, opening_session_at TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY, date TEXT NOT NULL, category TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL, payment_source TEXT NOT NULL,
  description TEXT, receipt_number TEXT, created_by TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, branch_id INTEGER,
  bank_account_id INTEGER, deposit_reference_number TEXT, bank_deposit_id INTEGER,
  is_voided BOOLEAN DEFAULT FALSE NOT NULL, void_reason TEXT, voided_by TEXT,
  voided_at TIMESTAMP, updated_by TEXT, update_reason TEXT
)`,
`CREATE TABLE IF NOT EXISTS bank_deposits (
  id SERIAL PRIMARY KEY, date TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
  reference_number TEXT, bank_name TEXT, notes TEXT, created_by TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  branch_id INTEGER, bank_account_id INTEGER
)`,
`CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL, order_id INTEGER,
  notification_type TEXT NOT NULL, channel TEXT DEFAULT 'sms',
  recipient TEXT NOT NULL, message TEXT NOT NULL, status TEXT DEFAULT 'pending',
  sent_at TIMESTAMP, error_message TEXT, dedupe_key TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS branch_features (
  id SERIAL PRIMARY KEY, branch_id INTEGER NOT NULL, feature_key TEXT NOT NULL,
  is_enabled BOOLEAN DEFAULT TRUE
)`,
`CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL, email TEXT, branch_id INTEGER, role TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP, must_change_password BOOLEAN DEFAULT FALSE NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS order_transfers (
  id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL, from_branch_id INTEGER,
  to_branch_id INTEGER NOT NULL, transfer_type TEXT NOT NULL,
  transferred_by INTEGER, transfer_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, notes TEXT
)`,
`CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, session_token TEXT NOT NULL,
  branch_id INTEGER, expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS payment_audit_log (
  id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL, action TEXT NOT NULL,
  old_payment_status TEXT, new_payment_status TEXT,
  old_paid_amount DOUBLE PRECISION, new_paid_amount DOUBLE PRECISION,
  old_payment_method TEXT, new_payment_method TEXT, changed_by TEXT,
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, notes TEXT
)`,
`CREATE TABLE IF NOT EXISTS loyalty_points (
  id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL,
  current_points INTEGER DEFAULT 0, lifetime_points INTEGER DEFAULT 0,
  tier TEXT DEFAULT 'Bronze', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL, order_id INTEGER,
  transaction_type TEXT NOT NULL, points INTEGER NOT NULL, description TEXT,
  balance_after INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  points_required INTEGER NOT NULL, discount_percentage DOUBLE PRECISION DEFAULT 0,
  discount_amount DOUBLE PRECISION DEFAULT 0, service_value DOUBLE PRECISION DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`
];

const CONSTRAINTS = [
`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_phone_key') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_phone_key UNIQUE (phone);
  END IF;
END $$`,
`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_username_key') THEN
    ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
  END IF;
END $$`,
`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_setting_key_key') THEN
    ALTER TABLE settings ADD CONSTRAINT settings_setting_key_key UNIQUE (setting_key);
  END IF;
END $$`,
`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_sessions_session_token_key') THEN
    ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_session_token_key UNIQUE (session_token);
  END IF;
END $$`,
`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_customer_id') THEN
    ALTER TABLE orders ADD CONSTRAINT fk_orders_customer_id FOREIGN KEY (customer_id) REFERENCES customers(id);
  END IF;
END $$`,
`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_service_id') THEN
    ALTER TABLE orders ADD CONSTRAINT fk_orders_service_id FOREIGN KEY (service_id) REFERENCES services(id);
  END IF;
END $$`,
`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_branch_id') THEN
    ALTER TABLE users ADD CONSTRAINT fk_users_branch_id FOREIGN KEY (branch_id) REFERENCES branches(id);
  END IF;
END $$`,
`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_item') THEN
    ALTER TABLE orders ADD CONSTRAINT fk_orders_item FOREIGN KEY (item_id) REFERENCES items(id);
  END IF;
END $$`
];

async function ensure() {
  try {
    for (const sql of TABLES) await db.run(sql, []);
    for (const sql of CONSTRAINTS) await db.run(sql, []);
    console.log('OK:  Core POS schema (18 tables + constraints) ready');
  } catch (err) {
    console.error('ERROR:  Core POS schema error:', err.message);
  }
}

ensure();
