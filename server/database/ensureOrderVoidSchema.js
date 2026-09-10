/**
 * Order void / transaction reversal schema (PostgreSQL).
 * Soft-void keeps audit trail; voided rows are excluded from cash totals and active order lists.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

(async () => {
  try {
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT FALSE', []);
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS void_reason TEXT', []);
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_by TEXT', []);
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP', []);

    await db.run('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT FALSE', []);
    await db.run('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS void_reason TEXT', []);
    await db.run('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_by TEXT', []);
    await db.run('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP', []);

    await db.run('CREATE INDEX IF NOT EXISTS idx_orders_voided ON orders(is_voided)', []);
    await db.run('CREATE INDEX IF NOT EXISTS idx_transactions_voided ON transactions(is_voided)', []);
  } catch (err) {
    console.error('ensureOrderVoidSchema failed:', err.message);
  }
})();
