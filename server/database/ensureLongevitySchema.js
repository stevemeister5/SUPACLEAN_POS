/**
 * Long-term POS resilience: partial indexes (active rows only), idempotency store,
 * normalized customer phone column for deduplication at scale.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');
const { shouldRunSchemaEnsure } = require('./schemaEnsure');
const { normalizePhoneDigits } = require('../utils/customerPhone');

async function backfillPhoneNormalizedBatch(limit = 5000) {
  const rows = await db.all(
    `SELECT id, phone FROM customers
     WHERE (phone_normalized IS NULL OR phone_normalized = '')
       AND phone IS NOT NULL
       AND TRIM(phone) <> ''
       AND phone NOT LIKE 'NO-PHONE:%'
     ORDER BY id ASC
     LIMIT ?`,
    [limit]
  );

  let updated = 0;
  let skipped = 0;

  for (const row of rows || []) {
    const normalized = normalizePhoneDigits(String(row.phone || '').trim());
    if (!normalized) continue;

    const existing = await db.get(
      'SELECT id FROM customers WHERE phone_normalized = ? LIMIT 1',
      [normalized]
    );
    if (existing && Number(existing.id) !== Number(row.id)) {
      skipped += 1;
      continue;
    }

    await db.run('UPDATE customers SET phone_normalized = ? WHERE id = ?', [normalized, row.id]);
    updated += 1;
  }

  return { updated, skipped, pending: (rows || []).length };
}

async function countDuplicateNormalizedPhones() {
  const row = await db.get(
    `SELECT COUNT(*) AS groups, COALESCE(SUM(cnt - 1), 0) AS extra_rows
     FROM (
       SELECT phone_normalized, COUNT(*) AS cnt
       FROM customers
       WHERE phone_normalized IS NOT NULL AND phone_normalized <> ''
       GROUP BY phone_normalized
       HAVING COUNT(*) > 1
     ) dupes`,
    []
  );
  return {
    groups: Number(row?.groups || 0),
    extra_rows: Number(row?.extra_rows || 0),
  };
}

async function ensurePhoneNormalizedIndexes() {
  // Remove strict unique index if a prior deploy created it before duplicates were handled.
  await db.run('DROP INDEX IF EXISTS idx_customers_phone_normalized', []);

  const dupes = await countDuplicateNormalizedPhones();
  if (dupes.groups === 0) {
    await db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone_normalized
       ON customers(phone_normalized)
       WHERE phone_normalized IS NOT NULL AND phone_normalized <> ''`,
      []
    );
    console.log('OK:  customers.phone_normalized unique index ready');
  } else {
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_customers_phone_normalized_lookup
       ON customers(phone_normalized)
       WHERE phone_normalized IS NOT NULL AND phone_normalized <> ''`,
      []
    );
    console.warn(
      `WARN: ️ Skipping unique phone index: ${dupes.groups} duplicate normalized phone group(s) (${dupes.extra_rows} extra customer row(s)). Merge duplicates via admin tools before enforcing uniqueness.`
    );
  }
}

(async () => {
  // Runs on long-running servers (local dev / Render); skipped on serverless
  // cold starts unless RUN_SCHEMA_ENSURE=1 (see ./schemaEnsure).
  if (!shouldRunSchemaEnsure()) return;
  try {
    await db.run(
      `CREATE TABLE IF NOT EXISTS idempotency_keys (
        idempotency_key TEXT NOT NULL,
        route TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (idempotency_key, route)
      )`,
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at)',
      []
    );

    await db.run('ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_normalized TEXT', []);

    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_orders_active_branch_date
       ON orders(branch_id, order_date DESC)
       WHERE archived_at IS NULL AND COALESCE(is_voided, FALSE) = FALSE`,
      []
    );
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_orders_active_branch_status
       ON orders(branch_id, status, order_date DESC)
       WHERE archived_at IS NULL AND COALESCE(is_voided, FALSE) = FALSE`,
      []
    );

    // Re-normalize legacy values (e.g. 0762665356 stored before TZ fix).
    const legacyRows = await db.all(
      `SELECT id, phone, phone_normalized FROM customers
       WHERE phone_normalized IS NOT NULL AND phone_normalized <> ''
       LIMIT 5000`,
      []
    );
    for (const row of legacyRows || []) {
      const expected = normalizePhoneDigits(String(row.phone || '').trim());
      if (!expected || expected === row.phone_normalized) continue;
      const owner = await db.get('SELECT id FROM customers WHERE phone_normalized = ? LIMIT 1', [expected]);
      if (owner && Number(owner.id) !== Number(row.id)) {
        await db.run('UPDATE customers SET phone_normalized = NULL WHERE id = ?', [row.id]);
        continue;
      }
      await db.run('UPDATE customers SET phone_normalized = ? WHERE id = ?', [expected, row.id]);
    }

    let totalUpdated = 0;
    let totalSkipped = 0;
    for (let i = 0; i < 20; i += 1) {
      const batch = await backfillPhoneNormalizedBatch(5000);
      totalUpdated += batch.updated;
      totalSkipped += batch.skipped;
      if (batch.pending === 0) break;
    }

    await ensurePhoneNormalizedIndexes();

    if (totalUpdated > 0 || totalSkipped > 0) {
      console.log(
        `OK:  Longevity schema ready (phone_normalized backfill: ${totalUpdated} updated, ${totalSkipped} duplicate(s) skipped)`
      );
    } else {
      console.log('OK:  Longevity schema ready');
    }
  } catch (err) {
    console.error('ensureLongevitySchema failed:', err.message);
  }
})();

module.exports = {
  backfillPhoneNormalizedBatch,
  countDuplicateNormalizedPhones,
};
