/**
 * Ensures bank_accounts table and bank_deposits columns exist when using PostgreSQL.
 * Run at server startup so Cash Management works without manual SQL.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

async function ensure() {
  try {
    await db.run(
      `CREATE TABLE IF NOT EXISTS bank_accounts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        account_number TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      []
    );
    await db.run('ALTER TABLE bank_deposits ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id)', []);
    await db.run('ALTER TABLE bank_deposits ADD COLUMN IF NOT EXISTS bank_account_id INTEGER REFERENCES bank_accounts(id)', []);
    await db.run('CREATE INDEX IF NOT EXISTS idx_bank_deposits_bank_account_id ON bank_deposits(bank_account_id)', []);
    await db.run('CREATE INDEX IF NOT EXISTS idx_bank_deposits_branch_id ON bank_deposits(branch_id)', []);
    // Expenses: allow "Bank Deposit" category with link to bank account and bank_deposits row
    await db.run('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS bank_account_id INTEGER', []);
    await db.run('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deposit_reference_number TEXT', []);
    await db.run('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS bank_deposit_id INTEGER', []);
    // Cash session controls for opening/closing reconciliation quality
    await db.run('ALTER TABLE daily_cash_summaries ADD COLUMN IF NOT EXISTS opening_cash_declared NUMERIC(14,2)', []);
    await db.run('ALTER TABLE daily_cash_summaries ADD COLUMN IF NOT EXISTS opening_variance NUMERIC(14,2) NOT NULL DEFAULT 0', []);
    await db.run('ALTER TABLE daily_cash_summaries ADD COLUMN IF NOT EXISTS opening_session_by TEXT', []);
    await db.run('ALTER TABLE daily_cash_summaries ADD COLUMN IF NOT EXISTS opening_session_at TIMESTAMP', []);
    // Frozen at reconcile: next day’s “expected opening” must use this, not a later recomputed closing_balance
    await db.run('ALTER TABLE daily_cash_summaries ADD COLUMN IF NOT EXISTS reconciled_closing_balance NUMERIC(14,2)', []);
    await db.run(
      `UPDATE daily_cash_summaries
       SET reconciled_closing_balance = closing_balance
       WHERE COALESCE(is_reconciled, FALSE) = TRUE
         AND reconciled_closing_balance IS NULL`,
      []
    );
    // Unpaid order balances (AR) for the order date — shown as Credit Sales on daily closing report
    await db.run('ALTER TABLE daily_cash_summaries ADD COLUMN IF NOT EXISTS credit_sales NUMERIC(14,2) NOT NULL DEFAULT 0', []);
    console.log('OK:  Banking schema (bank_accounts + expenses bank deposit) ready');
  } catch (err) {
    console.error('ERROR:  Banking schema migration error:', err.message);
  }
}

ensure();
