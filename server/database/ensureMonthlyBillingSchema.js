/**
 * Ensures Monthly Billing tables exist on PostgreSQL:
 *   invoices, delivery_notes, bills, bill_items, invoice_items, invoice_payments
 * plus the billing columns on customers.
 *
 * Mirrors scripts/migrate-monthly-billing.js + scripts/migrate-bills.js so
 * fresh databases are provisioned automatically at server startup.
 * Idempotent: safe to run on every boot (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

async function ensure() {
  // 1. Customers: billing columns used by invoice views/filters
  const customerCols = [
    ['billing_type', "TEXT DEFAULT 'per_order'"],
    ['company_name', 'TEXT'],
    ['tax_id', 'TEXT'],
    ['billing_address', 'TEXT'],
    ['billing_contact_name', 'TEXT'],
    ['billing_contact_phone', 'TEXT'],
    ['billing_contact_email', 'TEXT'],
    ['tin', 'TEXT'],
    ['vrn', 'TEXT'],
  ];
  for (const [col, def] of customerCols) {
    await db.run(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS ${col} ${def}`, []);
  }

  // 2. Invoices (FK-safe order: invoices first — bills/invoice_items reference it)
  await db.run(
    `CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      invoice_date DATE NOT NULL,
      due_date DATE NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      tax_rate REAL DEFAULT 0.18,
      tax_amount REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      credit_amount REAL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      balance_due REAL NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
      payment_terms TEXT DEFAULT 'Net 30',
      notes TEXT,
      branch_id INTEGER REFERENCES branches(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      sent_at TIMESTAMP,
      paid_at TIMESTAMP
    )`,
    []
  );

  // 3. Delivery notes (invoice_items has a delivery_note_id FK, so create first)
  await db.run(
    `CREATE TABLE IF NOT EXISTS delivery_notes (
      id SERIAL PRIMARY KEY,
      delivery_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      delivery_date DATE NOT NULL,
      service_id INTEGER REFERENCES services(id),
      item_name TEXT,
      quantity INTEGER DEFAULT 1,
      weight_kg REAL,
      unit_price REAL NOT NULL,
      total_amount REAL NOT NULL,
      notes TEXT,
      delivered_by TEXT,
      received_by TEXT,
      status TEXT DEFAULT 'delivered' CHECK (status IN ('delivered', 'returned', 'cancelled')),
      order_id INTEGER REFERENCES orders(id),
      invoice_id INTEGER REFERENCES invoices(id),
      branch_id INTEGER REFERENCES branches(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT
    )`,
    []
  );

  // 4. Bills (customer + billing date + line items; invoice_id set when invoiced)
  await db.run(
    `CREATE TABLE IF NOT EXISTS bills (
      id SERIAL PRIMARY KEY,
      bill_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      billing_date DATE NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      invoice_id INTEGER REFERENCES invoices(id),
      branch_id INTEGER REFERENCES branches(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT
    )`,
    []
  );

  // 5. Bill items
  await db.run(
    `CREATE TABLE IF NOT EXISTS bill_items (
      id SERIAL PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    []
  );

  // 6. Invoice line items (bill-based lines: bill_id + billing_date)
  await db.run(
    `CREATE TABLE IF NOT EXISTS invoice_items (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      delivery_note_id INTEGER REFERENCES delivery_notes(id),
      bill_id INTEGER REFERENCES bills(id),
      billing_date DATE,
      line_number INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      unit_price REAL NOT NULL,
      total_amount REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    []
  );

  // 7. Invoice payments
  await db.run(
    `CREATE TABLE IF NOT EXISTS invoice_payments (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      payment_date DATE NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT DEFAULT 'cash' CHECK (payment_method IN ('cash', 'bank_transfer', 'cheque', 'mobile_money', 'other')),
      reference_number TEXT,
      notes TEXT,
      branch_id INTEGER REFERENCES branches(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT
    )`,
    []
  );

  // 8. Indexes used by the invoice/bill queries
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date)',
    'CREATE INDEX IF NOT EXISTS idx_delivery_notes_customer_date ON delivery_notes(customer_id, delivery_date)',
    'CREATE INDEX IF NOT EXISTS idx_delivery_notes_order ON delivery_notes(order_id)',
    'CREATE INDEX IF NOT EXISTS idx_delivery_notes_invoice ON delivery_notes(invoice_id)',
    'CREATE INDEX IF NOT EXISTS idx_bills_customer_date ON bills(customer_id, billing_date)',
    'CREATE INDEX IF NOT EXISTS idx_bills_invoice ON bills(invoice_id)',
    'CREATE INDEX IF NOT EXISTS idx_bills_branch ON bills(branch_id)',
    'CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id)',
    'CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)',
    'CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id)',
  ];
  for (const sql of indexes) {
    await db.run(sql, []);
  }
}

module.exports = { ensure };

