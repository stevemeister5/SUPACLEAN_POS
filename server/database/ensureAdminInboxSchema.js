/**
 * Admin notification inbox / approval queue (PostgreSQL).
 * Holds void requests, cash-short alerts, AI suggestions, and similar admin-facing items.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

(async () => {
  try {
    await db.run(
      `CREATE TABLE IF NOT EXISTS admin_inbox (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        branch_id INTEGER,
        branch_name TEXT,
        branch_code TEXT,
        status TEXT NOT NULL DEFAULT 'unread',
        action_status TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        dedupe_key TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        requested_by TEXT,
        requested_by_user_id INTEGER,
        reviewed_by TEXT,
        reviewed_by_user_id INTEGER,
        reviewed_at TIMESTAMP,
        review_note TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      []
    );

    await db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_inbox_dedupe
       ON admin_inbox (dedupe_key)
       WHERE dedupe_key IS NOT NULL`,
      []
    );
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_admin_inbox_created_at ON admin_inbox (created_at DESC)`,
      []
    );
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_admin_inbox_pending
       ON admin_inbox (action_status)
       WHERE action_status = 'pending'`,
      []
    );
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_admin_inbox_unread
       ON admin_inbox (status)
       WHERE status = 'unread'`,
      []
    );
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_admin_inbox_branch ON admin_inbox (branch_id)`,
      []
    );
  } catch (err) {
    console.error('ensureAdminInboxSchema failed:', err.message);
  }
})();
