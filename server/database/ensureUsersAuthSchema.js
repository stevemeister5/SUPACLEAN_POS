/**
 * Users auth columns: email + must_change_password (PostgreSQL only).
 * Also repairs a prior bug that re-flagged username "admin" on every boot.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

const REPAIR_KEY = 'auth_admin_must_change_repair_v1';

async function ensure() {
  try {
    await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT', []);
    await db.run(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE',
      []
    );
    await db.run(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
      []
    );
    await db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized
       ON users (lower(trim(email)))
       WHERE email IS NOT NULL AND length(trim(email)) > 0`,
      []
    );

    // One-time repair only — never re-flag admin on every deploy/restart.
    // Login still forces a change when the typed password is a known weak default.
    const alreadyRepaired = await db
      .get('SELECT setting_value FROM settings WHERE setting_key = $1', [REPAIR_KEY])
      .catch(() => null);

    if (!alreadyRepaired) {
      await db
        .run(
          `UPDATE users SET must_change_password = FALSE
           WHERE LOWER(TRIM(username)) = 'admin'
             AND COALESCE(must_change_password, FALSE) = TRUE`,
          []
        )
        .catch(() => {});

      try {
        const existing = await db.get('SELECT id FROM settings WHERE setting_key = $1', [REPAIR_KEY]);
        if (existing) {
          await db.run(
            'UPDATE settings SET setting_value = $1, description = $2 WHERE setting_key = $3',
            ['done', 'Clears stuck must_change_password on admin after erroneous boot-time re-flag', REPAIR_KEY]
          );
        } else {
          await db.run(
            'INSERT INTO settings (setting_key, setting_value, description) VALUES ($1, $2, $3)',
            [
              REPAIR_KEY,
              'done',
              'Clears stuck must_change_password on admin after erroneous boot-time re-flag',
            ]
          );
        }
      } catch (_) {
        /* ignore marker write failures — repair UPDATE already ran */
      }

      console.log('OK:  Repaired stuck admin must_change_password flag (one-time)');
    }

    console.log('OK:  Users auth schema (email, must_change_password) ready');
  } catch (err) {
    console.error('ERROR:  Users auth schema error:', err.message);
  }
}

ensure();
