/**
 * PostgreSQL indexes for hot POS read paths (orders list, customers list, cash summaries).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

(async () => {
  try {
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_orders_branch_order_date ON orders(branch_id, order_date DESC)',
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_orders_branch_status_date ON orders(branch_id, status, order_date DESC)',
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_customers_primary_branch_created ON customers(primary_branch_id, created_at DESC)',
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_daily_cash_summaries_branch_date ON daily_cash_summaries(branch_id, date DESC)',
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_transactions_branch_date ON transactions(branch_id, transaction_date DESC)',
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_orders_receipt_number ON orders (receipt_number)',
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_orders_receipt_number_lower ON orders (lower(receipt_number))',
      []
    );
    // Customer tag search (ILIKE '%tag%') - trgm GIN keeps it indexed as the table grows
    await db.run('CREATE EXTENSION IF NOT EXISTS pg_trgm', []);
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_customers_tags_trgm ON customers USING gin (tags gin_trgm_ops)',
      []
    );
  } catch (err) {
    console.error('ensurePerformanceIndexes failed:', err.message);
  }
})();
