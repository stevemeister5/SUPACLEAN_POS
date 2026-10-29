/**
 * Customer tax identifiers (TIN / VRN).
 *
 * The customer quick-add form stores the taxpayer identification number (tin)
 * and the VAT registration number (vrn) on the `customers` table. PostgreSQL
 * gets them from ensurePosCoreSchema.js; SQLite databases created before these
 * fields existed need them added.
 *
 * Idempotent - safe to run on every boot. `ADD COLUMN IF NOT EXISTS` is valid
 * in PostgreSQL; the SQLite compatibility layer strips the clause and treats
 * "duplicate column name" as an already-applied migration.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');
const { shouldRunSchemaEnsure } = require('./schemaEnsure');

async function ensure() {
  if (!shouldRunSchemaEnsure()) return;
  try {
    await db.run('ALTER TABLE customers ADD COLUMN IF NOT EXISTS tin TEXT', []);
    await db.run('ALTER TABLE customers ADD COLUMN IF NOT EXISTS vrn TEXT', []);
    console.log('OK:  Customer tax identifiers (tin, vrn) ready');
  } catch (err) {
    console.error('ERROR:  Customer tax identifier schema error:', err.message);
  }
}

ensure();
