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
 *   SEED_CUSTOMERS=60   number of customers to create
 *   SEED_ORDERS=200     number of orders to create
 *   SEED_DAYS=60        orders are spread over the last N days
 *   SEED=20260920       PRNG seed (deterministic output)
 *   FORCE=1             wipe previously seeded data first (ignored in ORG_ONLY mode)
 *   ORG_ONLY=1          only upsert branches/services/users/settings/features;
 *                       never creates, wipes or alters customers/orders
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
/** Delete everything this script creates, in FK-safe order. */
async function wipeSeededData(client) {
  await client.query('DELETE FROM transactions');
  await client.query('DELETE FROM payment_audit_log');
  await client.query('DELETE FROM order_transfers');
  await client.query('DELETE FROM loyalty_transactions');
  await client.query('DELETE FROM loyalty_points');
  await client.query('DELETE FROM notifications');
  await client.query('DELETE FROM admin_inbox');
  await client.query('DELETE FROM daily_cash_summaries');
  await client.query('DELETE FROM orders');
  await client.query('DELETE FROM customers');
  await client.query('DELETE FROM branch_receipt_sequences');
  await client.query(
    `DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE username = ANY($1))`,
    [USERS.map((u) => u.username)]
  );
  await client.query('DELETE FROM users WHERE username = ANY($1)', [USERS.map((u) => u.username)]);
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
    if (!ORG_ONLY && (existingCustomers > 0 || existingOrders > 0) && !FORCE) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(
        `\nDatabase already has ${existingCustomers} customers and ${existingOrders} orders.\n` +
          'Re-run with FORCE=1 to clear the seeded data first.'
      );
      return;
    }
    if (FORCE && !ORG_ONLY && (existingCustomers > 0 || existingOrders > 0)) {
      console.log('[0/6] FORCE=1 — clearing previously seeded data...');
      await wipeSeededData(client);
    }

    console.log('[1/6] Branches, services, users, settings...');
    const branchesByCode = await seedBranches(client);
    const branches = [...branchesByCode.values()];
    const services = await seedServices(client);
    const createdUsers = await seedUsers(client, branchesByCode);
    await seedSettings(client);
    await seedBranchFeatures(client);

    if (ORG_ONLY) {
      await client.query('COMMIT');
      const org = await clientGet(
        client,
        `SELECT (SELECT COUNT(*)::int FROM branches) AS branches,
                (SELECT COUNT(*)::int FROM services) AS services,
                (SELECT COUNT(*)::int FROM users)    AS users,
                (SELECT COUNT(*)::int FROM branch_features) AS features`
      );
      console.log('\nORG_ONLY summary');
      console.log(`  branches      ${org.branches}`);
      console.log(`  services      ${org.services}`);
      console.log(`  users         ${org.users}`);
      console.log(`  branch flags  ${org.features}`);
      console.log('\nDone in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
      return;
    }

    console.log('[2/6] Customers...');
    const customerRows = generateCustomerRows(branches);
    const customers = await insertRows(
      client,
      'customers',
      ['name', 'phone', 'email', 'address', 'sms_notifications_enabled', 'primary_branch_id', 'phone_normalized'],
      customerRows,
      'id, name, phone'
    );
    console.log(`  + ${customers.length} customers`);

    console.log('[3/6] Orders...');
    const userNames = (await clientAll(client, 'SELECT full_name FROM users WHERE is_active = true ORDER BY id')).map((u) => u.full_name);
    const { rows: orderRows, receiptSeq } = generateOrderRows({ services, customers, branches, userNames });
    const insertedOrders = await insertRows(client, 'orders', ORDER_COLUMNS, orderRows.map((o) => o.values), 'id');
    console.log(`  + ${insertedOrders.length} orders`);

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

    await client.query('COMMIT');
    console.log('[6/6] Daily cash summaries...');
    await refreshDailySummaries([...receiptSeq.keys()]);

    const counts = await clientGet(
      client,
      `SELECT (SELECT COUNT(*)::int FROM branches) AS branches,
              (SELECT COUNT(*)::int FROM services) AS services,
              (SELECT COUNT(*)::int FROM users)    AS users,
              (SELECT COUNT(*)::int FROM customers) AS customers,
              (SELECT COUNT(*)::int FROM orders)   AS orders,
              (SELECT COUNT(*)::int FROM transactions) AS transactions,
              (SELECT COUNT(*)::int FROM daily_cash_summaries) AS summaries`
    );

    console.log('\n' + '='.repeat(74));
    console.log('Seeded database state');
    console.log('='.repeat(74));
    console.log(`  branches      ${counts.branches}`);
    console.log(`  services      ${counts.services}`);
    console.log(`  users         ${counts.users}`);
    console.log(`  customers     ${counts.customers}`);
    console.log(`  orders        ${counts.orders}`);
    console.log(`  transactions  ${counts.transactions}`);
    console.log(`  cash summaries ${counts.summaries}`);

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






