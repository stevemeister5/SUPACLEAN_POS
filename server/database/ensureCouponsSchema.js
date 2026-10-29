/**
 * Coupons schema (PostgreSQL).
 * A coupon program with a minimum order amount of 20,000 TSh.
 * - `coupons.code` is UNIQUE (applied at checkout via /api/coupons/validate).
 * - `used_count` is incremented atomically when a coupon is applied to an order.
 * - `orders.coupon_id` + `orders.discount_amount` record the applied coupon per order (audit).
 * Idempotent — safe to run on every boot.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

(async () => {
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS coupons (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'percent',
      value DOUBLE PRECISION NOT NULL DEFAULT 0,
      min_order_amount DOUBLE PRECISION NOT NULL DEFAULT 20000,
      max_uses INTEGER DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      starts_at TIMESTAMP,
      expires_at TIMESTAMP,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      branch_id INTEGER,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, []);

    await db.run('ALTER TABLE coupons ADD CONSTRAINT coupons_code_key UNIQUE (code)', []).catch(() => {});
    await db.run('CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code)', []);

    // Audit columns on orders: which coupon was applied and the discount granted
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_id INTEGER', []);
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT', []);
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount DOUBLE PRECISION DEFAULT 0', []);
    await db.run('CREATE INDEX IF NOT EXISTS idx_orders_coupon_id ON orders(coupon_id)', []);
  } catch (err) {
    console.error('ensureCouponsSchema failed:', err.message);
  }
})();
