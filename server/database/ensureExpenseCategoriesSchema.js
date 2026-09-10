/**
 * Branch-scoped custom expense category names (PostgreSQL).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

async function ensure() {
  try {
    await db.run(
      `CREATE TABLE IF NOT EXISTS expense_categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      []
    );
    await db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_branch_lower_name ON expense_categories (branch_id, lower(btrim(name)))',
      []
    );
    await db.run('CREATE INDEX IF NOT EXISTS idx_expense_categories_branch_id ON expense_categories (branch_id)', []);
    console.log('OK:  Expense categories schema ready');
  } catch (err) {
    console.error('ERROR:  Expense categories schema migration error:', err.message);
  }
}

ensure();
