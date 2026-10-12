/**
 * SUPACLEAN POS — baseline seed for a fresh environment.
 *
 * Creates the minimum a working branch needs: branches, services (mirrored from
 * the price list in `items`), staff logins, customers, orders, payment
 * transactions, receipt sequences and daily cash summaries.
 *
 * Usage (from the project root):
 *   DATABASE_URL=postgresql://... node scripts/seed-baseline.js
 *
 * Env knobs:
 *   SEED_CUSTOMERS=60   number of walk-in customers to create
 *   SEED_ORDERS=200     number of orders to create
 *   SEED_DAYS=60        orders are spread over the last N days
 *   SEED=20260920       PRNG seed (deterministic output)
 *   FORCE=1             wipe previously seeded data first (ignored in ORG_ONLY mode)
 *   ORG_ONLY=1          only upsert branches/services/users/settings/features/bank
 *                       accounts/employees; never creates, wipes or alters
 *                       customers/orders/money data
 *   MONEY_ONLY=1        seed only the Money & reports data (expenses, deposits,
 *                       payroll, monthly billing) — requires customers to exist
 *                       already; never touches orders/customers
 *
 * Safe to re-run: branches/services/users/settings/features are upserted, and
 * the script refuses to add orders/customers when the database already has
 * some (unless FORCE=1). ORG_ONLY never refuses and never deletes.
 *
 * Data seeded on a full run:
 *   3 branches (AR01 Main, AR02 collection point, AR10 workshop)
 *   services mirrored from the price list in `items`
 *   3 staff logins: admin (admin/admin123), manager (manager/manager123),
 *     cashier (cashier/cashier123) — change the passwords after first login
 *   default app settings + per-branch feature flags (otherwise non-admin users
 *     get 403 from requireBranchFeature())
 *   60 customers, 200 orders/payment transactions, receipt sequences and daily
 *   cash summaries
 */

'use strict';

const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Example:\n  DATABASE_URL=postgresql://... node scripts/seed-baseline.js');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────
const CONFIG = {
  customers: parseInt(process.env.SEED_CUSTOMERS || '60', 10),
  orders: parseInt(process.env.SEED_ORDERS || '200', 10),
  days: parseInt(process.env.SEED_DAYS || '60', 10),
};
const SEED = parseInt(process.env.SEED || '20260920', 10);
const FORCE = process.env.FORCE === '1';
/** Upsert branches/services/users/settings/features only (no wipe, no customers/orders). */
const ORG_ONLY = process.env.ORG_ONLY === '1';
/** Seed only the Money & reports data (assumes customers/orders already exist). */
const MONEY_ONLY = process.env.MONEY_ONLY === '1';

/** Branch split for generated orders (weights sum to 1). */
const BRANCHES = [
  { code: 'AR01', name: 'Main Branch', type: 'workshop', address: 'Njiro Road, Arusha', phone: '+255 754 100 100', manager: 'Hassan Masawe', orderShare: 0.5 },
  { code: 'AR02', name: 'Sakina Collection Point', type: 'collection', address: 'Sakina, Arusha', phone: '+255 754 100 200', manager: 'Aisha Kimaro', orderShare: 0.25 },
  { code: 'AR10', name: 'Kijenge Workshop', type: 'workshop', address: 'Kijenge Industrial Area, Arusha', phone: '+255 754 100 300', manager: 'Juma Mwangi', orderShare: 0.25 },
];

/**
 * Staff logins. `admin123` is the documented bootstrap password; the login
 * route forces a password change for it because it is a known weak default.
 * Change all three from the Users page after the first login.
 */
const USERS = [
  { username: 'admin', password: 'admin123', fullName: 'System Administrator', role: 'admin', branchCode: null, email: 'admin@supaclean.co.tz' },
  { username: 'manager', password: 'manager123', fullName: 'Rehema Sanga', role: 'manager', branchCode: 'AR01', email: 'manager@supaclean.co.tz' },
  { username: 'cashier', password: 'cashier123', fullName: 'Baraka Minja', role: 'cashier', branchCode: 'AR01', email: 'cashier@supaclean.co.tz' },
];

/** Service types that are not tied to a single price-list item. */
const EXTRA_SERVICES = [
  { name: 'Pressing only', description: 'Ironing / press only', basePrice: 2000, pricePerItem: 2000, pricePerKg: 0 },
  { name: 'Drying only', description: 'Tumble dry only', basePrice: 3000, pricePerItem: 0, pricePerKg: 3000 },
];

const SETTINGS = [
  { key: 'express_same_day_multiplier', value: '2', description: 'Same-day express surcharge multiplier' },
  { key: 'express_next_day_multiplier', value: '3', description: 'Next-day express surcharge multiplier' },
  { key: 'express_same_day_hours', value: '8', description: 'Same-day express turnaround (hours)' },
  { key: 'express_next_day_hours', value: '3', description: 'Next-day express turnaround (days)' },
  { key: 'high_season_mode', value: 'false', description: 'High season pricing/queue mode' },
  { key: 'sms_sending_enabled', value: 'true', description: 'Send SMS notifications to customers' },
];

/** Company billing descriptions used by Monthly Billing bills and invoices. */
const BILL_LINES = [
  ['Corporate laundry — staff uniforms (monthly)', [6500, 7200, 8000, 9200, 11000]],
  ['Hotel linen service — room turnover', [12000, 15000, 18000, 21000]],
  ['Clinic linen service — monthly contract', [9000, 11500, 13200]],
  ['School uniform pressing — term service', [5400, 6600, 7800]],
  ['Guest house duvet & blanket wash', [14000, 17000, 19500]],
  ['Restaurant table & kitchen linen', [8800, 9600, 12400]],
];

/** Extra custom expense categories added per spending branch. */
const SEED_EXPENSE_CATEGORIES = ['Detergent & Chemicals', 'Packaging & Hangers', 'Staff Welfare'];

/**
 * Default branch feature flags, mirroring
 * server/database/ensureBranchFeaturesSchema.js exactly. Without these rows
 * the app's requireBranchFeature() middleware returns 403 for every non-admin
 * user, so a fresh database must have them.
 */
const FEATURE_DEFAULTS = {
  collection: [
    ['new_order', true], ['collection', true], ['customers', true],
    ['price_list_view', true], ['cash_management', true], ['reports_basic', true],
    ['order_processing', false], ['expenses', false], ['bank_deposits', false],
    ['service_management', false], ['cleaning_services', false], ['payroll', false],
  ],
  workshop: [
    ['new_order', true], ['collection', true], ['customers', true],
    ['price_list_view', true], ['cash_management', true], ['reports_basic', true],
    ['order_processing', true], ['expenses', true], ['bank_deposits', true],
    ['service_management', true], ['cleaning_services', false], ['payroll', true],
  ],
};

const PAYMENT_METHODS = [
  { w: 6, v: 'cash' },
  { w: 2, v: 'mobile_money' },
  { w: 1.5, v: 'card' },
  { w: 0.5, v: 'bank_transfer' },
];

const GARMENT_COLORS = ['White', 'Black', 'Blue', 'Grey', 'Navy', 'Beige', 'Green', 'Maroon', 'Mixed', null];

const INSTRUCTIONS = [
  'Customer will collect on Saturday',
  'Handle with care - delicate fabric',
  'Remove stain on the collar',
  null,
  null,
  null,
  'Call when ready for collection',
  'No starch please',
  null,
];

// ──────────────────────────────────────────────────────────────────────────
// Database
// ──────────────────────────────────────────────────────────────────────────
const isLocalDatabase = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
});

// Reads that must run on the seeding transaction's own connection, otherwise the
// rows inserted moments ago are invisible (they are not committed yet).
const clientAll = (client, sql, params) => client.query(sql, params).then((r) => r.rows);
const clientGet = (client, sql, params) => client.query(sql, params).then((r) => (r.rows.length ? r.rows[0] : null));

// ──────────────────────────────────────────────────────────────────────────
// Deterministic PRNG (same approach as scripts/seed-10k.js)
// ──────────────────────────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class RNG {
  constructor(seed) {
    this.r = mulberry32(seed >>> 0);
  }
  int(min, max) { return min + Math.floor(this.r() * (max - min + 1)); }
  pick(arr) { return arr[this.int(0, arr.length - 1)]; }
  chance(p) { return this.r() < p; }
  weighted(items) {
    const total = items.reduce((s, i) => s + i.w, 0);
    let r = this.r() * total;
    for (const it of items) { r -= it.w; if (r <= 0) return it.v; }
    return items[items.length - 1].v;
  }
  /** Shuffle a copy. */
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

const rng = (tag) => new RNG(SEED * 31 + tag * 17);

// ──────────────────────────────────────────────────────────────────────────
// Reference data — Tanzanian names / phones / addresses
// ──────────────────────────────────────────────────────────────────────────
const FIRST_NAMES = [
  'Juma', 'Ahmed', 'Mohamed', 'Ibrahim', 'Hassan', 'Omar', 'Ali', 'Rashid', 'Yusuf', 'Baraka',
  'Pius', 'Joseph', 'John', 'Michael', 'Peter', 'Samuel', 'Daniel', 'Victor', 'Emmanuel', 'Frank',
  'Aisha', 'Mariam', 'Fatuma', 'Zahra', 'Salma', 'Nadia', 'Amira', 'Hana', 'Rehema', 'Neema',
  'Grace', 'Joyce', 'Mary', 'Rose', 'Jane', 'Sarah', 'Elizabeth', 'Lucy', 'Amina', 'Halima',
  'Chiku', 'Pili', 'Nuru', 'Furaha', 'Tumaini', 'Salama', 'Imani', 'Zawadi',
];

const LAST_NAMES = [
  'Mwangi', 'Kimaro', 'Mrema', 'Sanga', 'Masumbo', 'Mgaya', 'Mbwambo', 'Minja', 'Mdoe', 'Mlacha',
  'Makame', 'Matata', 'Masawe', 'Msuya', 'Mushi', 'Mkumbo', 'Mamba', 'Lema', 'Mwinyi', 'Mwakalinga',
  'Shayo', 'Nkya', 'Kessy', 'Meena', 'Ndosi', 'Mollel', 'Laizer', 'Sarakikya', 'Mkwawa', 'Mwansasu',
];

const STREETS = ['Njiro Road', 'Sakina Street', 'Kijenge Road', 'Dodoma Road', 'Mosque Street', 'Market Road', 'Sokoine Road', 'Kaloleni Street'];
const AREAS = ['Njiro', 'Sakina', 'Kijenge', 'Kaloleni', 'Themi', 'Sekei', 'Olasiti', 'Kiranyi'];

const COMPANIES = [
  'Kilimanjaro Hotel', 'Arusha Serena', 'Mount Meru Lodge', 'Safari Inn', 'Kiranyi Secondary School',
  'Njiro Clinic', 'Themi Guest House', 'Kijenge Trade Center', 'Sekei Primary School', 'Olasiti Dispensary',
];

const EXPENSE_DESCRIPTIONS = {
  Rent: ['Monthly shop rent', 'Workshop rent payment', 'Store rent'],
  'Car Fuel': ['Petrol for delivery van', 'Fuel for pickup run', 'Diesel refill'],
  Lunch: ['Staff lunch', 'Lunch for workshop team', 'Team lunch'],
  Breakfast: ['Morning tea and mandazi', 'Breakfast for early shift'],
  'Water Bill': ['Monthly water bill', 'Water usage payment'],
  Electricity: ['Monthly electricity bill', 'LUKU top up'],
  'Office Supplies': ['Receipt books', 'Printer toner', 'Stationery'],
  Transport: ['Boda fare', 'Delivery transport', 'Courier charge'],
  'Maintenance & Repairs': ['Washing machine repair', 'Dryer service', 'Plumbing fix'],
  Other: ['Miscellaneous supplies', 'Cleaning materials', 'Packaging bags'],
};

function makePhone(r, used) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const prefix = r.pick(['71', '74', '75', '76', '78', '79', '65', '67', '68', '69']);
    const sub = String(1000000 + r.int(0, 8999999)).slice(-7);
    const phone = `+255 ${prefix}${sub.slice(0, 3)} ${sub.slice(3, 5)} ${sub.slice(5)}`;
    if (!used.has(phone)) {
      used.add(phone);
      return phone;
    }
  }
  throw new Error('Could not generate a unique phone number');
}

const makeAddress = (r) => `${r.pick(STREETS)}, ${r.pick(AREAS)}, Arusha`;

// ──────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ──────────────────────────────────────────────────────────────────────────
const dayOf = (d) => new Date(d).getDate();
const monthOf = (d) => new Date(d).getMonth() + 1;
const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
const isoDateTime = (d) => new Date(d).toISOString().slice(0, 19);
const tsh = (n) => Math.round(n / 100) * 100;

/** Receipt number in the app's own format: "AR01 7-4-9" (prefix seq-day-month). */
const buildReceiptNumber = (prefix, sequence, date) =>
  `${prefix} ${sequence}-${dayOf(date)}-${monthOf(date)}`;

/** Multi-row INSERT ... RETURNING. */
async function insertRows(client, table, columns, rows, returning = null, chunkSize = 200) {
  const inserted = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const placeholders = chunk.map((row) => {
      const slots = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${slots.join(', ')})`;
    });
    const sql =
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')}` +
      (returning ? ` RETURNING ${returning}` : '');
    const result = await client.query(sql, values);
    if (returning) inserted.push(...result.rows);
  }
  return inserted;
}

// ──────────────────────────────────────────────────────────────────────────
// Organization: branches, services, users, settings
// ──────────────────────────────────────────────────────────────────────────
async function seedBranches(client) {
  const byCode = new Map();
  for (const branch of BRANCHES) {
    const existing = await client.query('SELECT * FROM branches WHERE code = $1', [branch.code]);
    if (existing.rows.length) {
      byCode.set(branch.code, existing.rows[0]);
      console.log(`  = branch ${branch.code} already exists`);
      continue;
    }
    const inserted = await client.query(
      `INSERT INTO branches (name, code, branch_type, address, phone, manager_name, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *`,
      [branch.name, branch.code, branch.type, branch.address, branch.phone, branch.manager]
    );
    byCode.set(branch.code, inserted.rows[0]);
    console.log(`  + branch ${branch.code} — ${branch.name} (${branch.type})`);
  }
  return byCode;
}

/**
 * Services mirror the price list in `items` (same name/price) so the New Order
 * screen can match a picked item to its service, plus standalone service types.
 */
async function seedServices(client) {
  const items = await clientAll(client, 'SELECT id, name, base_price, service_type FROM items ORDER BY id');
  const existing = await clientAll(client, 'SELECT id, name FROM services');
  const known = new Set(existing.map((s) => String(s.name).toLowerCase()));

  const toCreate = [];
  for (const item of items) {
    if (known.has(String(item.name).toLowerCase())) continue;
    const price = Number(item.base_price) || 0;
    toCreate.push({
      name: item.name,
      description: item.service_type || 'Wash, Press & Hanged',
      basePrice: price,
      pricePerItem: 0,
      pricePerKg: /1\s*kg/i.test(item.name) ? price : 0,
    });
  }
  for (const service of EXTRA_SERVICES) {
    if (known.has(service.name.toLowerCase())) continue;
    toCreate.push(service);
  }

  if (toCreate.length) {
    await insertRows(
      client,
      'services',
      ['name', 'description', 'base_price', 'price_per_item', 'price_per_kg', 'is_active'],
      toCreate.map((s) => [s.name, s.description, s.basePrice, s.pricePerItem, s.pricePerKg, true])
    );
  }
  console.log(`  + services: ${toCreate.length} created, ${existing.length} already present`);

  return clientAll(
    client,
    'SELECT id, name, description, base_price, price_per_item, price_per_kg FROM services WHERE is_active = true ORDER BY id'
  );
}

async function seedUsers(client, branchesByCode) {
  const created = [];
  for (const user of USERS) {
    const existing = await clientGet(client, 'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)', [user.username]);
    if (existing) {
      console.log(`  = user ${user.username} already exists`);
      continue;
    }
    const hash = await bcrypt.hash(user.password, 10);
    const branch = user.branchCode ? branchesByCode.get(user.branchCode) : null;
    await client.query(
      `INSERT INTO users (username, password_hash, full_name, email, role, branch_id, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, true, false)`,
      [user.username, hash, user.fullName, user.email, user.role, branch ? branch.id : null]
    );
    created.push(user.username);
    console.log(`  + user ${user.username} (${user.role}${branch ? ` @ ${branch.code}` : ', all branches'})`);
  }
  return created;
}

async function seedSettings(client) {
  let added = 0;
  for (const setting of SETTINGS) {
    const result = await client.query(
      `INSERT INTO settings (setting_key, setting_value, description)
       VALUES ($1, $2, $3) ON CONFLICT (setting_key) DO NOTHING`,
      [setting.key, setting.value, setting.description]
    );
    added += result.rowCount;
  }
  console.log(`  + settings: ${added} default(s) added`);
}

/**
 * Runs the billing schema migration (CREATE TABLE IF NOT EXISTS). Exported by
 * server/database/ensureMonthlyBillingSchema.js but never called at boot, so a
 * fresh database has no billing tables until this runs.
 */
async function ensureBillingSchema(client) {
  await client.query(
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
    )`
  );
  await client.query(
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
    )`
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS bill_items (
      id SERIAL PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS invoice_items (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      delivery_note_id INTEGER,
      bill_id INTEGER REFERENCES bills(id),
      billing_date DATE,
      line_number INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      unit_price REAL NOT NULL,
      total_amount REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await client.query(
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
    )`
  );
  console.log('  = billing tables ensured (invoices, bills, bill_items, invoice_items, invoice_payments)');
}

/**
 * Money & reports seed: expenses, salary advances, bank deposits, payroll
 * snapshot and monthly billing. Only touches branches whose feature flags
 * allow the corresponding screen, and only past dates (the API rejects
 * future business dates).
 */
async function seedMoneyData(client, { branches, userNames }) {
  const now = new Date();
  const todayIso = isoDate(now);
  const r = rng(9);
  const summary = {
    expenseCount: 0, advanceCount: 0, depositCount: 0,
    payrollRows: 0, billCount: 0, invoiceCount: 0, paymentCount: 0,
    expenseDateKeys: [],
  };

  // ── Expense categories + expenses ──────────────────────────────────────
  const spendBranches = await expenseBranchIds(client, branches);
  console.log(`  · expenses: ${spendBranches.length} branch(es) with the expenses flag`);
  for (const branch of spendBranches) {
    for (const name of SEED_EXPENSE_CATEGORIES) {
      await client.query(
        `INSERT INTO expense_categories (name, branch_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [name, branch.id]
      );
    }
  }

  const categories = [
    'Rent', 'Car Fuel', 'Lunch', 'Breakfast', 'Water Bill', 'Electricity',
    'Office Supplies', 'Transport', 'Maintenance & Repairs', 'Other',
    ...SEED_EXPENSE_CATEGORIES,
  ];
  const AMOUNT_RANGE = {
    Rent: [250000, 400000], 'Car Fuel': [30000, 80000], Lunch: [8000, 25000],
    Breakfast: [5000, 15000], 'Water Bill': [20000, 60000], Electricity: [30000, 90000],
    'Office Supplies': [10000, 45000], Transport: [4000, 18000],
    'Maintenance & Repairs': [25000, 120000], Other: [5000, 30000],
    'Detergent & Chemicals': [60000, 180000], 'Packaging & Hangers': [25000, 70000],
    'Staff Welfare': [15000, 50000],
  };
  const SOURCES = [{ w: 6, v: 'cash' }, { w: 3, v: 'mpesa' }, { w: 1, v: 'bank' }];

  const expenseRows = [];
  for (const branch of spendBranches) {
    // ~18 expenses per branch over the last 8 weeks
    for (let i = 0; i < 18; i += 1) {
      const daysAgo = r.int(0, 55);
      const date = new Date(now.getTime() - daysAgo * 86400000);
      const category = r.pick(categories);
      const [min, max] = AMOUNT_RANGE[category] || [5000, 40000];
      const amount = tsh(r.int(min, max));
      expenseRows.push([
        isoDate(date), category, amount, r.weighted(SOURCES),
        r.pick(EXPENSE_DESCRIPTIONS[category] || ['Operating cost']),
        `SEED-EXP-${branch.code}-${i + 1}`, 'Seed Data', branch.id,
      ]);
      summary.expenseDateKeys.push(`${branch.id}|${isoDate(date)}`);
    }
    // One fixed monthly rent entry for each of the last 2 months
    for (let monthsAgo = 1; monthsAgo <= 2; monthsAgo += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 5);
      expenseRows.push([
        isoDate(d), 'Rent', 300000, 'bank', 'Monthly shop rent (seed)',
        `SEED-EXP-${branch.code}-RENT${monthsAgo}`, 'Seed Data', branch.id,
      ]);
      summary.expenseDateKeys.push(`${branch.id}|${isoDate(d)}`);
    }
  }
  const insertedExpenses = await insertRows(
    client,
    'expenses',
    ['date', 'category', 'amount', 'payment_source', 'description', 'receipt_number', 'created_by', 'branch_id'],
    expenseRows,
    'id'
  );
  summary.expenseCount = insertedExpenses.length;
  console.log(`  + ${insertedExpenses.length} expenses across ${spendBranches.length} branch(es)`);

  // ── Salary advances (2 per employee in the current month) ────────────────
  const employees = await clientAll(
    client,
    'SELECT id, full_name, branch_id FROM employees WHERE is_active = true ORDER BY id'
  );
  const advanceRows = [];
  for (const employee of employees) {
    for (let i = 0; i < 2; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth(), 3 + i * 12);
      if (d > now) d.setTime(now.getTime() - (i + 1) * 86400000);
      advanceRows.push([
        employee.id, isoDate(d), tsh(r.int(40000, 90000)),
        'Seed: advance against this month\'s salary', employee.branch_id, 'Seed Data',
      ]);
    }
  }
  await insertRows(
    client,
    'salary_advances',
    ['employee_id', 'advance_date', 'amount', 'notes', 'branch_id', 'created_by'],
    advanceRows
  );
  summary.advanceCount = advanceRows.length;
  console.log(`  + ${advanceRows.length} salary advances for ${employees.length} employee(s)`);

  return { summary, employees, advanceRows };
}

/** Bank deposits: one per week per deposit-enabled branch. */
async function seedBankDeposits(client, branches, r) {
  const depositEnabled = await clientAll(
    client,
    `SELECT DISTINCT branch_id FROM branch_features WHERE feature_key = 'bank_deposits' AND is_enabled = true`
  );
  const allowed = new Set(depositEnabled.map((d) => Number(d.branch_id)));
  const bankAccounts = await clientAll(
    client,
    'SELECT id, name FROM bank_accounts WHERE is_active = true ORDER BY id'
  );
  const depositRows = [];
  const now = new Date();
  const todayIso = isoDate(now);
  for (const branch of branches) {
    if (!allowed.has(Number(branch.id))) continue;
    for (let week = 0; week < 8; week += 1) {
      const d = new Date(now.getTime() - week * 7 * 86400000);
      if (isoDate(d) > todayIso) continue;
      const account = bankAccounts.length ? r.pick(bankAccounts) : null;
      depositRows.push([
        isoDate(d), tsh(r.int(300000, 900000)),
        `SEED-DEP-${branch.code}-${week + 1}`,
        account ? account.name : null,
        'Weekly cash deposit (seed)', 'Seed Data', branch.id,
        account ? account.id : null,
      ]);
    }
  }
  await insertRows(
    client,
    'bank_deposits',
    ['date', 'amount', 'reference_number', 'bank_name', 'notes', 'created_by', 'branch_id', 'bank_account_id'],
    depositRows
  );
  return depositRows.length;
}

/** Tanzania monthly resident employment PAYE bands (mirrors routes/payroll.js). */
function estimateMonthlyPAYE(taxableIncome) {
  const x = Math.max(0, Number(taxableIncome) || 0);
  if (x <= 270000) return 0;
  if (x <= 520000) return (x - 270000) * 0.08;
  if (x <= 760000) return 20000 + (x - 520000) * 0.2;
  if (x <= 1000000) return 68000 + (x - 760000) * 0.25;
  return 128000 + (x - 1000000) * 0.3;
}

/** Payroll snapshot for the current and previous month. */
async function seedPayroll(client, employees, advanceRows) {
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const previousDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonthKey = `${previousDate.getFullYear()}-${String(previousDate.getMonth() + 1).padStart(2, '0')}`;

  const payrollRows = [];
  for (const employee of employees) {
    for (const monthKey of [currentMonthKey, previousMonthKey]) {
      const gross = Number(employee.gross_salary) || 0;
      const allowances = Number(employee.default_allowances) || 0;
      const bonuses = Number(employee.default_bonuses) || 0;
      const nssfAmount = Math.round((gross * 10) / 100);
      const employerNssf = Math.round((gross * 10) / 100);
      const taxable = Math.max(0, gross + allowances + bonuses - nssfAmount);
      const paye = Math.round(estimateMonthlyPAYE(taxable));
      const advancesTotal = advanceRows
        .filter((a) => a[0] === employee.id && String(a[1]).startsWith(monthKey))
        .reduce((sum, a) => sum + a[2], 0);
      const totalDeductions = nssfAmount + paye + advancesTotal;
      const net = gross + allowances + bonuses - totalDeductions;
      payrollRows.push([
        monthKey, employee.id, gross, allowances, bonuses,
        nssfAmount, 10, 10, employerNssf, taxable, paye, 0, advancesTotal,
        totalDeductions, net, employee.branch_id, 'Seed Data', true, true,
      ]);
    }
  }
  await insertRows(
    client,
    'payroll_monthly',
    ['month_key', 'employee_id', 'gross_salary', 'allowances', 'bonuses',
     'nssf_amount', 'nssf_employee_rate', 'nssf_employer_rate', 'employer_nssf_amount',
     'taxable_income', 'paye_amount', 'other_deductions', 'salary_advances',
     'total_deductions', 'net_salary', 'branch_id', 'computed_by', 'nssf_enabled', 'paye_enabled'],
    payrollRows
  );
  // Older months read as closed in the payroll history view.
  await client.query(
    `INSERT INTO payroll_periods (month_key, status, completed_on, closed_at, closed_by)
     VALUES ($1, 'closed', $2::date, CURRENT_TIMESTAMP, 'Seed Data')
     ON CONFLICT (month_key) DO NOTHING`,
    [previousMonthKey, isoDate(new Date(now.getFullYear(), now.getMonth(), 0))]
  );
  await client.query(
    `INSERT INTO payroll_periods (month_key, status) VALUES ($1, 'open')
     ON CONFLICT (month_key) DO NOTHING`,
    [currentMonthKey]
  );
  return { payrollRows: payrollRows.length, currentMonthKey, previousMonthKey };
}

/**
 * Monthly billing: company customers, one bill per month each, then one
 * invoice per customer/month grouping those bills. Roughly a third of the
 * invoices are settled so the list shows paid, overdue and open documents.
 */
async function seedBilling(client, branches, r) {
  const now = new Date();
  const todayIso = isoDate(now);

  // 1. Company customers (monthly billing contracts), idempotent by phone.
  const companyRows = [];
  for (let i = 0; i < COMPANIES.length; i += 1) {
    const company = COMPANIES[i];
    const phone = `+255 768 ${String(2000 + i).padStart(4, '0')} 10${i}`;
    const existing = await clientGet(
      client,
      'SELECT id, name FROM customers WHERE company_name = $1 OR name = $1 LIMIT 1',
      [company]
    );
    if (existing) {
      companyRows.push(existing);
      continue;
    }
    const inserted = await client.query(
      `INSERT INTO customers (name, phone, email, address, sms_notifications_enabled,
                              primary_branch_id, phone_normalized, billing_type, company_name,
                              tax_id, billing_address, billing_contact_name, billing_contact_phone)
       VALUES ($1,$2,$3,$4,0,$5,$6,'monthly',$1,$7,$8,$9,$10) RETURNING id, name`,
      [
        company, phone, `accounts@${company.toLowerCase().replace(/[^a-z]+/g, '')}.co.tz`,
        `${AREAS[i % AREAS.length]}, Arusha`, branches[0].id, phone.replace(/[^0-9+]/g, ''),
        `TIN-${String(100000000 + i * 137)}`, `${company}, ${AREAS[i % AREAS.length]}, Arusha`,
        'Accounts Office', phone,
      ]
    );
    companyRows.push(inserted.rows[0]);
  }
  console.log(`  + ${companyRows.length} monthly billing customer(s)`);

  // 2. Bills: one per company per month for the last 3 months (1-2 lines each).
  let billCount = 0;
  const uninvoicedBills = [];
  for (const customer of companyRows) {
    const lineTemplate = BILL_LINES[billCount % BILL_LINES.length];
    for (let monthAgo = 0; monthAgo < 3; monthAgo += 1) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - monthAgo, r.int(3, 25));
      const billingDate = isoDate(monthDate);
      if (billingDate > todayIso) continue;
      const billNumber = `BIL-SEED-${customer.id}-${monthAgo + 1}`;
      if (await clientGet(client, 'SELECT id FROM bills WHERE bill_number = $1', [billNumber])) continue;
      const lines = r.shuffle(lineTemplate[1]).slice(0, r.int(1, 2));
      const subtotal = lines.reduce((sum, unit) => sum + tsh(unit), 0);
      const billResult = await client.query(
        `INSERT INTO bills (bill_number, customer_id, billing_date, subtotal, total_amount, branch_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'Seed Data') RETURNING id`,
        [billNumber, customer.id, billingDate, subtotal, subtotal, branches[0].id]
      );
      const billId = billResult.rows[0].id;
      for (const unit of lines) {
        await client.query(
          `INSERT INTO bill_items (bill_id, description, quantity, unit_price, total_amount)
           VALUES ($1,$2,1,$3,$3)`,
          [billId, lineTemplate[0], tsh(unit)]
        );
      }
      uninvoicedBills.push({ billId, billingDate, total: subtotal, customerId: customer.id });
      billCount += 1;
    }
  }
  console.log(`  + ${billCount} bills for ${companyRows.length} billing customer(s)`);

  return { uninvoicedBills, companyRows };
}

/** Group a customer's uninvoiced bills into one invoice per month. */
async function seedInvoices(client, uninvoicedBills, branches, r) {
  const now = new Date();
  const todayIso = isoDate(now);
  const byCustomerMonth = new Map();
  for (const bill of uninvoicedBills) {
    const key = `${bill.customerId}|${bill.billingDate.slice(0, 7)}`;
    if (!byCustomerMonth.has(key)) byCustomerMonth.set(key, []);
    byCustomerMonth.get(key).push(bill);
  }

  let invoiceCount = 0;
  let paymentCount = 0;
  let counter = 1;
  for (const [key, bills] of byCustomerMonth) {
    const customerId = Number(key.split('|')[0]);
    const monthKey = key.split('|')[1];
    bills.sort((a, b) => (a.billingDate < b.billingDate ? -1 : 1));
    const periodStart = bills[0].billingDate;
    const periodEnd = bills[bills.length - 1].billingDate;
    const subtotal = bills.reduce((sum, b) => sum + b.total, 0);
    const taxAmount = Math.round(subtotal * 0.18);
    const totalAmount = subtotal + taxAmount;
    const dueDate = new Date(`${periodEnd}T00:00:00Z`);
    dueDate.setUTCDate(dueDate.getUTCDate() + 30);
    const invoiceNumber = `INV-SEED-${monthKey.replace('-', '')}-${String(counter).padStart(3, '0')}`;
    counter += 1;

    const isPastDue = isoDate(dueDate) < todayIso;
    const settle = r.chance(0.4);
    const status = settle ? 'paid' : isPastDue ? 'overdue' : 'sent';

    const invoiceResult = await client.query(
      `INSERT INTO invoices (
         invoice_number, customer_id, invoice_date, due_date, period_start, period_end,
         subtotal, tax_rate, tax_amount, discount, credit_amount, total_amount,
         paid_amount, balance_due, status, notes, branch_id, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,0.18,$8,0,0,$9,$10,$11,$12,$13,$14,'Seed Data') RETURNING id`,
      [
        invoiceNumber, customerId, periodEnd, isoDate(dueDate), periodStart, periodEnd,
        subtotal, taxAmount, totalAmount, settle ? totalAmount : 0,
        settle ? 0 : totalAmount, status, 'Monthly service invoice (seed)', branches[0].id,
      ]
    );
    const invoiceId = invoiceResult.rows[0].id;
    let lineNumber = 1;
    for (const bill of bills) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, bill_id, billing_date, line_number, description, quantity, unit_price, total_amount)
         VALUES ($1,$2,$3,$4,$5,1,$6,$6)`,
        [invoiceId, bill.billId, bill.billingDate, lineNumber++, `Bill ${bill.billingDate}`, bill.total]
      );
      await client.query('UPDATE bills SET invoice_id = $1 WHERE id = $2', [invoiceId, bill.billId]);
    }
    invoiceCount += 1;

    if (settle) {
      const paidDate = isPastDue ? isoDate(dueDate) : todayIso;
      await client.query(
        `INSERT INTO invoice_payments (invoice_id, payment_date, amount, payment_method, reference_number, notes, branch_id, created_by)
         VALUES ($1,$2,$3,$4,$5,'Seed payment',$6,'Seed Data')`,
        [invoiceId, paidDate, totalAmount, r.chance(0.5) ? 'bank_transfer' : 'cash', `SEED-PAY-${invoiceId}`, branches[0].id]
      );
      await client.query(
        'UPDATE invoices SET paid_at = CURRENT_TIMESTAMP WHERE id = $1',
        [invoiceId]
      );
      paymentCount += 1;
    }
  }
  console.log(`  + ${invoiceCount} invoices (${paymentCount} paid, the rest sent/overdue)`);
  return { invoiceCount, paymentCount };
}




/** Expense-spending branches: only branches whose flags allow the Expenses page. */
async function expenseBranchIds(client, branches) {
  const rows = await clientAll(
    client,
    `SELECT DISTINCT branch_id FROM branch_features WHERE feature_key = 'expenses' AND is_enabled = true`
  );
  const allowed = new Set(rows.map((r) => Number(r.branch_id)));
  return branches.filter((b) => allowed.has(Number(b.id)));
}

async function seedBranchFeatures(client) {
  let added = 0;
  const branches = await clientAll(client, 'SELECT id, branch_type FROM branches ORDER BY id');
  for (const branch of branches) {
    const defaults = FEATURE_DEFAULTS[branch.branch_type] || FEATURE_DEFAULTS.workshop;
    for (const [key, enabled] of defaults) {
      const result = await client.query(
        `INSERT INTO branch_features (branch_id, feature_key, is_enabled)
         VALUES ($1, $2, $3) ON CONFLICT (branch_id, feature_key) DO NOTHING`,
        [branch.id, key, enabled]
      );
      added += result.rowCount;
    }
  }
  console.log(`  + branch features: ${added} default row(s) added`);
}

/** Bank accounts: created once per name, never deleted by the wipe. */
async function seedBankAccounts(client) {
  const existing = await clientAll(client, 'SELECT id, name FROM bank_accounts ORDER BY id');
  const known = new Set(existing.map((a) => String(a.name).toLowerCase()));
  const wanted = [
    ['NBC Arusha Main', '0123456789'],
    ['CRDB Njiro', '0198765432'],
  ];
  const created = [];
  for (const [name, number] of wanted) {
    if (known.has(name.toLowerCase())) {
      created.push(existing.find((a) => String(a.name).toLowerCase() === name.toLowerCase()));
      continue;
    }
    const inserted = await client.query(
      'INSERT INTO bank_accounts (name, account_number, is_active) VALUES ($1, $2, true) RETURNING *',
      [name, number]
    );
    created.push(inserted.rows[0]);
    console.log(`  + bank account ${name}`);
  }
  return created;
}

/** Payroll employees: upserted by code, so a re-run never duplicates staff. */
async function seedEmployees(client, branchesByCode) {
  const pickBranch = (code) => {
    const b = branchesByCode.get(code);
    return b ? b.id : (branchesByCode.get('AR01') ? branchesByCode.get('AR01').id : null);
  };
  const STAFF = [
    { code: 'SCL-EMP-001', fullName: 'Hassan Masawe', tinNumber: '104-223-558', phone: '+255 754 111 001', branchCode: 'AR01', gross: 650000, allowances: 150000, bonuses: 50000 },
    { code: 'SCL-EMP-002', fullName: 'Aisha Kimaro', tinNumber: '104-223-559', phone: '+255 754 111 002', branchCode: 'AR02', gross: 480000, allowances: 80000, bonuses: 30000 },
    { code: 'SCL-EMP-003', fullName: 'Baraka Minja', tinNumber: '104-223-560', phone: '+255 754 111 003', branchCode: 'AR01', gross: 420000, allowances: 60000, bonuses: 20000 },
    { code: 'SCL-EMP-004', fullName: 'Juma Mwangi', tinNumber: '104-223-561', phone: '+255 754 111 004', branchCode: 'AR10', gross: 520000, allowances: 100000, bonuses: 40000 },
    { code: 'SCL-EMP-005', fullName: 'Neema Sanga', tinNumber: '104-223-562', phone: '+255 754 111 005', branchCode: 'AR01', gross: 380000, allowances: 50000, bonuses: 0 },
    { code: 'SCL-EMP-006', fullName: 'Victor Mushi', tinNumber: '104-223-563', phone: '+255 754 111 006', branchCode: 'AR10', gross: 460000, allowances: 70000, bonuses: 25000 },
  ];
  const rows = [];
  for (const person of STAFF) {
    const existing = await clientGet(client, 'SELECT * FROM employees WHERE employee_code = $1', [person.code]);
    if (existing) {
      rows.push(existing);
      console.log(`  = employee ${person.code} already exists`);
      continue;
    }
    const inserted = await client.query(
      `INSERT INTO employees (full_name, employee_code, tin_number, phone, branch_id, gross_salary,
                              default_allowances, default_bonuses, default_other_deductions,
                              nssf_enabled, nssf_employee_rate, nssf_employer_rate, paye_enabled, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,true,10,10,true,true) RETURNING *`,
      [
        person.fullName, person.code, person.tinNumber, person.phone, pickBranch(person.branchCode),
        person.gross, person.allowances, person.bonuses,
      ]
    );
    rows.push(inserted.rows[0]);
    console.log(`  + employee ${person.code} — ${person.fullName}`);
  }
  return rows;
}

// ──────────────────────────────────────────────────────────────────────────
// Data generators
// ──────────────────────────────────────────────────────────────────────────
function generateCustomerRows(branchList) {
  const r = rng(2);
  const usedPhones = new Set();
  const rows = [];
  for (let i = 0; i < CONFIG.customers; i += 1) {
    const first = r.pick(FIRST_NAMES);
    const last = r.pick(LAST_NAMES);
    const phone = makePhone(r, usedPhones);
    const branch = r.chance(0.35) ? r.pick(branchList) : null;
    rows.push([
      `${first} ${last}`,
      phone,
      r.chance(0.45) ? `${first.toLowerCase()}.${last.toLowerCase()}@example.co.tz` : null,
      makeAddress(r),
      r.chance(0.85) ? 1 : 0,
      branch ? branch.id : null,
      phone.replace(/[^0-9+]/g, ''),
    ]);
  }
  return rows;
}

/**
 * Build order rows plus the per (branch, date) receipt sequence watermark, so
 * in-app order creation continues after the seeded receipts.
 */
function generateOrderRows({ services, customers, branches, userNames }) {
  const r = rng(3);
  const now = Date.now();
  const rows = [];
  const receiptSeq = new Map(); // `${branchId}|${YYYY-MM-DD}` -> last sequence used

  const branchesForOrder = [];
  for (const branch of branches) {
    const share = BRANCHES.find((b) => b.code === branch.code)?.orderShare ?? 0;
    for (let i = 0; i < Math.round(share * 100); i += 1) branchesForOrder.push(branch);
  }
  if (branchesForOrder.length === 0) branchesForOrder.push(...branches);

  for (let i = 0; i < CONFIG.orders; i += 1) {
    const service = r.pick(services);
    const customer = r.pick(customers);
    const branch = r.pick(branchesForOrder);

    // Spread over the last CONFIG.days, weighted towards recent days.
    const daysAgo = r.chance(0.6) ? r.int(0, 14) : r.int(0, CONFIG.days - 1);
    const orderDate = new Date(now - daysAgo * 86400000);
    orderDate.setHours(r.int(8, 18), r.int(0, 59), 0, 0);
    // Never date a seeded order in the future (today's orders respect the clock).
    if (orderDate.getTime() > now) orderDate.setTime(now - r.int(5, 180) * 60000);

    // Orders older than 5 days are almost always collected by now.
    const status = r.weighted(
      daysAgo > 5
        ? [{ w: 8, v: 'collected' }, { w: 1, v: 'ready' }, { w: 1, v: 'processing' }]
        : [{ w: 4, v: 'collected' }, { w: 3, v: 'ready' }, { w: 2, v: 'processing' }, { w: 1, v: 'pending' }]
    );

    const quantity = r.int(1, 4);
    const weightKg = Number(service.price_per_kg) > 0 ? r.int(1, 8) * 0.5 : null;

    let total = (Number(service.base_price) || 0) * quantity;
    if (Number(service.price_per_item) > 0) total += Number(service.price_per_item) * quantity;
    if (weightKg) total += weightKg * Number(service.price_per_kg);

    const deliveryType = r.weighted([{ w: 8, v: 'standard' }, { w: 1, v: 'next_day' }, { w: 0.6, v: 'same_day' }]);
    let expressMultiplier = 0;
    if (deliveryType === 'same_day') { expressMultiplier = 2; total *= 2; }
    if (deliveryType === 'next_day') { expressMultiplier = 3; total *= 3; }
    const totalAmount = tsh(Math.max(total, 1000));

    // Payment: fully paid / advance / unpaid — values match server/utils/paymentValidation.js
    let paymentStatus;
    let paidAmount;
    if (status === 'collected') {
      paymentStatus = r.weighted([{ w: 9, v: 'paid_full' }, { w: 1, v: 'advance' }]);
    } else {
      paymentStatus = r.weighted([{ w: 5, v: 'paid_full' }, { w: 3, v: 'advance' }, { w: 2, v: 'not_paid' }]);
    }
    if (paymentStatus === 'paid_full') {
      paidAmount = totalAmount;
    } else if (paymentStatus === 'advance') {
      paidAmount = tsh(totalAmount * r.pick([0.3, 0.4, 0.5, 0.6, 0.7]));
      if (paidAmount <= 0 || paidAmount >= totalAmount) paidAmount = tsh(totalAmount * 0.5);
    } else {
      paidAmount = 0;
    }
    const paymentMethod = r.weighted(PAYMENT_METHODS);

    const estimatedCollectionDate = new Date(orderDate);
    estimatedCollectionDate.setDate(
      estimatedCollectionDate.getDate() + (deliveryType === 'same_day' ? 0 : r.int(1, 4))
    );
    estimatedCollectionDate.setHours(r.int(10, 17), 0, 0, 0);

    let readyDate = null;
    let collectedDate = null;
    if (status === 'ready' || status === 'collected') {
      readyDate = new Date(orderDate.getTime() + r.int(1, 3) * 86400000);
      readyDate.setHours(r.int(9, 17), 0, 0, 0);
      if (readyDate.getTime() > now) readyDate = new Date(now - r.int(30, 240) * 60000);
    }
    if (status === 'collected') {
      collectedDate = new Date(readyDate.getTime() + r.int(0, 3) * 86400000);
      collectedDate.setHours(r.int(9, 18), 0, 0, 0);
      if (collectedDate.getTime() > now) collectedDate = new Date(now - r.int(5, 60) * 60000);
    }

    const seqKey = `${branch.id}|${isoDate(orderDate)}`;
    const sequence = (receiptSeq.get(seqKey) || 0) + 1;
    receiptSeq.set(seqKey, sequence);
    const receiptNumber = buildReceiptNumber(branch.code, sequence, orderDate);

    rows.push({
      receiptNumber,
      customerId: customer.id,
      branchId: branch.id,
      paymentStatus,
      paidAmount,
      paymentMethod,
      orderDate,
      values: [
        receiptNumber,
        customer.id,
        service.id,
        service.name,
        r.pick(GARMENT_COLORS),
        quantity,
        weightKg,
        r.pick(INSTRUCTIONS),
        deliveryType,
        expressMultiplier,
        status,
        totalAmount,
        paidAmount,
        paymentStatus,
        paymentMethod,
        isoDateTime(orderDate),
        readyDate ? isoDateTime(readyDate) : null,
        collectedDate ? isoDateTime(collectedDate) : null,
        r.pick(userNames),
        false,
        null,
        null,
        null,
        null,
        null,
        null,
        isoDateTime(estimatedCollectionDate),
        status === 'collected' ? branch.id : null,
        branch.id,
        status === 'ready' || status === 'collected' ? branch.id : null,
        branch.id,
      ],
    });
  }

  return { rows, receiptSeq };
}

const ORDER_COLUMNS = [
  'receipt_number', 'customer_id', 'service_id', 'garment_type', 'color',
  'quantity', 'weight_kg', 'special_instructions', 'delivery_type',
  'express_surcharge_multiplier', 'status', 'total_amount', 'paid_amount',
  'payment_status', 'payment_method', 'order_date', 'ready_date',
  'collected_date', 'created_by', 'is_voided', 'void_reason', 'voided_by',
  'voided_at', 'archived_at', 'archived_by', 'archive_reason',
  'estimated_collection_date', 'collected_at_branch_id', 'created_at_branch_id',
  'ready_at_branch_id', 'branch_id',
];

// ──────────────────────────────────────────────────────────────────────────
// Teardown + main
// ──────────────────────────────────────────────────────────────────────────
/** Wipe only the Money & reports tables (MONEY_ONLY + FORCE). */
async function wipeMoneyData(client) {
  await client.query('DELETE FROM transactions');
  await client.query('DELETE FROM payment_audit_log');
  await client.query('DELETE FROM order_transfers');
  await client.query('DELETE FROM loyalty_transactions');
  await client.query('DELETE FROM loyalty_points');
  await client.query('DELETE FROM notifications');
  await client.query('DELETE FROM admin_inbox');
  await client.query('DELETE FROM daily_cash_summaries');
  await client.query('DELETE FROM expense_audit_log');
  await client.query('DELETE FROM salary_advances');
  await client.query('DELETE FROM expenses');
  await client.query(`DELETE FROM invoice_items`);
  await client.query(`DELETE FROM invoice_payments`);
  await client.query('DELETE FROM bills');
  await client.query('DELETE FROM invoices');
  await client.query("DELETE FROM bank_deposits WHERE reference_number LIKE 'SEED-DEP-%'");
  await client.query('DELETE FROM payroll_monthly');
  await client.query(`DELETE FROM payroll_periods WHERE month_key LIKE '20%'`);
  await client.query(`DELETE FROM bill_items`);
}

/** Full wipe: money tables plus the orders/customers this script created. */
async function wipeSeededData(client) {
  await wipeMoneyData(client);
  await client.query('DELETE FROM customer_notes');
  await client.query('DELETE FROM orders');
  await client.query('DELETE FROM customers');
}

async function main() {
  const started = Date.now();
  console.log('='.repeat(74));
  console.log('SUPACLEAN POS — baseline seed');
  console.log(`customers=${CONFIG.customers}  orders=${CONFIG.orders}  days=${CONFIG.days}  seed=${SEED}  force=${FORCE}`);
  console.log(`target: ${String(process.env.DATABASE_URL).replace(/:\/\/[^@]*@/, '://***@').split('?')[0]}`);
  console.log('='.repeat(74));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT (SELECT COUNT(*)::int FROM customers) AS customers,
              (SELECT COUNT(*)::int FROM orders)    AS orders`
    );
    const { customers: existingCustomers, orders: existingOrders } = existing.rows[0];
    if (MONEY_ONLY) {
      const moneyProbe = await client.query(
        `SELECT (SELECT COUNT(*)::int FROM expenses) AS expenses,
                (SELECT COUNT(*)::int FROM bank_deposits) AS deposits,
                (SELECT COUNT(*)::int FROM payroll_monthly) AS payroll`
      );
      const seeded = moneyProbe.rows[0];
      if (!FORCE && (seeded.expenses > 0 || seeded.deposits > 0 || seeded.payroll > 0)) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(
          `\nMoney data already present (expenses=${seeded.expenses}, deposits=${seeded.deposits}, payroll=${seeded.payroll}).\n` +
            'Re-run with FORCE=1 to clear the money data first.'
        );
        return;
      }
      if (FORCE) {
        console.log('[0/6] FORCE=1 — clearing previously seeded money data...');
        await wipeMoneyData(client);
      }
    } else if (!ORG_ONLY && (existingCustomers > 0 || existingOrders > 0) && !FORCE) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(
        `\nDatabase already has ${existingCustomers} customers and ${existingOrders} orders.\n` +
          'Re-run with FORCE=1 to clear the seeded data first.'
      );
      return;
    }
    if (FORCE && !MONEY_ONLY && !ORG_ONLY && (existingCustomers > 0 || existingOrders > 0)) {
      console.log('[0/6] FORCE=1 — clearing previously seeded data...');
      await wipeSeededData(client);
    }

    console.log('[1/6] Branches, services, users, settings, banking, staff...');
    const branchesByCode = await seedBranches(client);
    const branches = [...branchesByCode.values()];
    const services = await seedServices(client);
    const createdUsers = await seedUsers(client, branchesByCode);
    await seedSettings(client);
    await seedBranchFeatures(client);
    const bankAccounts = await seedBankAccounts(client);
    const employees = await seedEmployees(client, branchesByCode);
    await ensureBillingSchema(client);

    if (ORG_ONLY) {
      await client.query('COMMIT');
      const org = await clientGet(
        client,
        `SELECT (SELECT COUNT(*)::int FROM branches) AS branches,
                (SELECT COUNT(*)::int FROM services) AS services,
                (SELECT COUNT(*)::int FROM users)    AS users,
                (SELECT COUNT(*)::int FROM branch_features) AS features,
                (SELECT COUNT(*)::int FROM bank_accounts) AS bank_accounts,
                (SELECT COUNT(*)::int FROM employees) AS employees`
      );
      console.log('\nORG_ONLY summary');
      console.log(`  branches      ${org.branches}`);
      console.log(`  services      ${org.services}`);
      console.log(`  users         ${org.users}`);
      console.log(`  branch flags  ${org.features}`);
      console.log(`  bank accounts ${org.bank_accounts}`);
      console.log(`  employees     ${org.employees}`);
      console.log('\nDone in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
      return;
    }

    const moneyOnly = MONEY_ONLY;
    let customers = moneyOnly
      ? await clientAll(client, 'SELECT id, name FROM customers ORDER BY id')
      : null;
    let receiptSeq = new Map();
    let userNames = (await clientAll(client, 'SELECT full_name FROM users WHERE is_active = true ORDER BY id')).map((u) => u.full_name);

    if (!moneyOnly) {
      console.log('[2/6] Customers...');
      const customerRows = generateCustomerRows(branches);
      customers = await insertRows(
        client,
        'customers',
        ['name', 'phone', 'email', 'address', 'sms_notifications_enabled', 'primary_branch_id', 'phone_normalized'],
        customerRows,
        'id, name, phone'
      );
      console.log(`  + ${customers.length} customers`);

      console.log('[3/6] Orders...');
      const { rows: orderRows, receiptSeq: seq } = generateOrderRows({ services, customers, branches, userNames });
      const insertedOrders = await insertRows(client, 'orders', ORDER_COLUMNS, orderRows.map((o) => o.values), 'id');
      console.log(`  + ${insertedOrders.length} orders`);
      receiptSeq = seq;

      console.log('[4/6] Payment transactions...');
      const transactionRows = [];
      insertedOrders.forEach((inserted, index) => {
        const order = orderRows[index];
        if (order.paidAmount > 0) {
          transactionRows.push([
            inserted.id,
            'payment_received',
            order.paidAmount,
            order.paymentMethod,
            `Payment for order ${order.receiptNumber}`,
            isoDateTime(order.orderDate),
            userNames[index % userNames.length],
            order.branchId,
          ]);
        }
      });
      await insertRows(
        client,
        'transactions',
        ['order_id', 'transaction_type', 'amount', 'payment_method', 'description', 'transaction_date', 'created_by', 'branch_id'],
        transactionRows
      );
      console.log(`  + ${transactionRows.length} payment transactions`);

      console.log('[5/6] Receipt sequences...');
      let sequenceCount = 0;
      for (const [key, lastSeq] of receiptSeq) {
        const [branchId, seqDate] = key.split('|');
        await client.query(
          `INSERT INTO branch_receipt_sequences (branch_id, seq_date, last_seq)
           VALUES ($1, $2::date, $3)
           ON CONFLICT (branch_id, seq_date)
           DO UPDATE SET last_seq = GREATEST(branch_receipt_sequences.last_seq, EXCLUDED.last_seq),
                         updated_at = CURRENT_TIMESTAMP`,
          [branchId, seqDate, lastSeq]
        );
        sequenceCount += 1;
      }
      console.log(`  + ${sequenceCount} branch/day receipt sequences`);
    }

    console.log(moneyOnly ? '[6/6] Money & reports data...' : '[5/6] Money & reports data...');
    const money = await seedMoneyData(client, { branches, userNames });
    const depositCount = await seedBankDeposits(client, branches, rng(9));
    money.summary.depositCount = depositCount;
    const payroll = await seedPayroll(client, money.employees, money.advanceRows);
    money.summary.payrollRows = payroll.payrollRows;
    const billing = await seedBilling(client, branches, rng(9));
    const invoices = await seedInvoices(client, billing.uninvoicedBills, branches, rng(9));
    money.summary.billCount = billing.billCount;
    money.summary.invoiceCount = invoices.invoiceCount;
    money.summary.paymentCount = invoices.paymentCount;

    await client.query('COMMIT');
    console.log(moneyOnly ? '[6/6] Daily cash summaries...' : '[6/6] Daily cash summaries...');
    await refreshDailySummaries([...receiptSeq.keys(), ...money.summary.expenseDateKeys]);

    const counts = await clientGet(
      client,
      `SELECT (SELECT COUNT(*)::int FROM branches) AS branches,
              (SELECT COUNT(*)::int FROM services) AS services,
              (SELECT COUNT(*)::int FROM users)    AS users,
              (SELECT COUNT(*)::int FROM customers) AS customers,
              (SELECT COUNT(*)::int FROM orders)   AS orders,
              (SELECT COUNT(*)::int FROM transactions) AS transactions,
              (SELECT COUNT(*)::int FROM daily_cash_summaries) AS summaries,
              (SELECT COUNT(*)::int FROM expenses) AS expenses,
              (SELECT COUNT(*)::int FROM bank_deposits) AS deposits,
              (SELECT COUNT(*)::int FROM employees) AS employees,
              (SELECT COUNT(*)::int FROM payroll_monthly) AS payroll,
              (SELECT COUNT(*)::int FROM bills) AS bills,
              (SELECT COUNT(*)::int FROM invoices) AS invoices`
    );

    console.log('\n' + '='.repeat(74));
    console.log('Seeded database state');
    console.log('='.repeat(74));
    console.log(`  branches       ${counts.branches}`);
    console.log(`  services       ${counts.services}`);
    console.log(`  users          ${counts.users}`);
    console.log(`  employees      ${counts.employees}`);
    console.log(`  bank accounts  ${counts.deposits >= 0 ? bankAccounts.length : 0}`);
    console.log(`  customers      ${counts.customers}`);
    console.log(`  orders         ${counts.orders}`);
    console.log(`  transactions   ${counts.transactions}`);
    console.log(`  cash summaries ${counts.summaries}`);
    console.log(`  expenses       ${counts.expenses}`);
    console.log(`  bank deposits  ${counts.deposits}`);
    console.log(`  payroll rows   ${counts.payroll}`);
    console.log(`  bills          ${counts.bills}`);
    console.log(`  invoices       ${counts.invoices}`);

    console.log('\n' + '='.repeat(74));
    console.log('Login credentials (change the passwords after the first login)');
    console.log('='.repeat(74));
    for (const user of USERS) {
      const scope = user.branchCode ? `branch ${user.branchCode}` : 'all branches';
      console.log(`  ${user.username.padEnd(9)} / ${user.password.padEnd(11)} ${user.role.padEnd(8)} ${scope}`);
    }
    if (createdUsers.length === 0) {
      console.log('\n(users already existed — passwords were left untouched)');
    }
    console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Recompute daily cash summaries with the app's own logic so the Cash
 * Management screen matches the seeded orders/transactions. Best effort: the
 * app recalculates summaries on page load anyway.
 */
async function refreshDailySummaries(dateKeys) {
  if (process.env.SKIP_DAILY_SUMMARY_REFRESH === '1') {
    console.log('  - skipped (SKIP_DAILY_SUMMARY_REFRESH=1)');
    return;
  }
  try {
    if (!isLocalDatabase && !process.env.NODE_ENV) process.env.NODE_ENV = 'production';
    // eslint-disable-next-line global-require
    const { refreshUnreconciledDailySummary } = require('../server/routes/cashManagement');
    const unique = [...new Set(dateKeys.map((k) => k.split('|')[1]))].sort();
    let done = 0;
    for (const date of unique) {
      for (const key of dateKeys.filter((k) => k.endsWith(`|${date}`))) {
        const branchId = Number(key.split('|')[0]);
        await refreshUnreconciledDailySummary(date, branchId);
        done += 1;
      }
    }
    console.log(`  + ${done} daily summaries refreshed across ${unique.length} day(s)`);
  } catch (err) {
    console.warn(`  ! daily summary refresh skipped: ${err.message}`);
    console.warn('    (the Cash Management screen recalculates these on load)');
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nERROR:', err.message);
    pool.end().finally(() => process.exit(1));
  });






