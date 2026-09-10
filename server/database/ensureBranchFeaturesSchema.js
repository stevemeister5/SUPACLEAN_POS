/**
 * Branch features: UNIQUE(branch_id, feature_key) + FK + backfill.
 * Branches created before setDefaultFeatures (or via seed scripts) have
 * zero feature rows, so requireBranchFeature('collection') 403s every
 * non-admin user. Backfills defaults per branch_type on every boot.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

const DEFAULTS = {
  collection: [
    ['new_order', true], ['collection', true], ['customers', true],
    ['price_list_view', true], ['cash_management', true], ['reports_basic', true],
    ['order_processing', false], ['expenses', false], ['bank_deposits', false],
    ['service_management', false], ['cleaning_services', false], ['payroll', false],
  ],
  workshop: [
    ['new_order', true], ['collection', true], ['customers', true],
    ['price_list_view', true], ['cash_management', true], ['reports_basic', true],
    ['order_processing', true], ['expenses', true], ['bank_deposits', true],
    ['service_management', true], ['cleaning_services', false], ['payroll', true],
  ],
};

async function ensure() {
  try {
    await db.run(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_features_branch_id_feature_key_key') THEN
          ALTER TABLE branch_features ADD CONSTRAINT branch_features_branch_id_feature_key_key UNIQUE (branch_id, feature_key);
        END IF;
      END $$`,
      []
    );
    await db.run(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_branch_features_branch_id') THEN
          ALTER TABLE branch_features ADD CONSTRAINT fk_branch_features_branch_id FOREIGN KEY (branch_id) REFERENCES branches(id);
        END IF;
      END $$`,
      []
    );
    const branches = await db.all('SELECT id, branch_type FROM branches', []);
    let inserted = 0;
    for (const b of branches || []) {
      const feats = DEFAULTS[b.branch_type] || DEFAULTS.workshop;
      for (const [key, enabled] of feats) {
        const r = await db.run(
          'INSERT INTO branch_features (branch_id, feature_key, is_enabled) VALUES ($1, $2, $3) ON CONFLICT (branch_id, feature_key) DO NOTHING',
          [b.id, key, enabled]
        );
        inserted += r.changes || 0;
      }
    }
    console.log(`OK:  Branch features schema ready (${inserted} defaults backfilled)`);
  } catch (err) {
    console.error('ERROR:  Branch features schema error:', err.message);
  }
}

ensure();
