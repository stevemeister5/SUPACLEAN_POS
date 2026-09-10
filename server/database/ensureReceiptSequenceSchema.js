/**
 * Atomic per-branch daily receipt sequence counters (PostgreSQL).
 * Prevents duplicate receipt numbers when multiple cashiers create orders at once.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

async function ensure() {
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS branch_receipt_sequences (
        branch_id INTEGER NOT NULL DEFAULT 0,
        seq_date DATE NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (branch_id, seq_date)
      )`,
      []
    );
    await db.query(
      'CREATE INDEX IF NOT EXISTS idx_branch_receipt_sequences_date ON branch_receipt_sequences(seq_date)',
      []
    );
    console.log('OK:  branch_receipt_sequences ready');
  } catch (err) {
    console.error('ERROR:  branch_receipt_sequences migration error:', err.message);
  }
}

ensure();
