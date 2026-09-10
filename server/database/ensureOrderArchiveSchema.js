/**
 * Order archive schema (PostgreSQL).
 * Archived orders stay available for history/audit, but are hidden from active operational views.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

(async () => {
  try {
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP', []);
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_by TEXT', []);
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS archive_reason TEXT', []);

    await db.run('CREATE INDEX IF NOT EXISTS idx_orders_archived_at ON orders(archived_at)', []);
    await db.run('CREATE INDEX IF NOT EXISTS idx_orders_branch_archived_status ON orders(branch_id, archived_at, status)', []);
  } catch (err) {
    console.error('ensureOrderArchiveSchema failed:', err.message);
  }
})();
