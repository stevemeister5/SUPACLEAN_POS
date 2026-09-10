/**
 * SMS marketing + global SMS sending control (PostgreSQL only).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

(async () => {
  try {
    await db.run(
      `CREATE TABLE IF NOT EXISTS sms_marketing_templates (
        id BIGSERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        message TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      []
    );

    await db.run(
      `CREATE TABLE IF NOT EXISTS sms_marketing_campaigns (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        template_id BIGINT NOT NULL,
        audience_tags TEXT,
        audience_all INTEGER DEFAULT 0,
        recipient_count INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        suppressed_count INTEGER DEFAULT 0,
        skipped_duplicate_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft',
        dry_run INTEGER DEFAULT 0,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (template_id) REFERENCES sms_marketing_templates(id)
      )`,
      []
    );

    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_sms_marketing_templates_active
       ON sms_marketing_templates(is_active)
       WHERE is_active = 1`,
      []
    );

    // Default global switch (so newly onboarded instances have SMS on by default).
    await db.run(
      `INSERT INTO settings (setting_key, setting_value, description)
       VALUES ('sms_sending_enabled', 'true', 'Globally allow SMS sending to customers')
       ON CONFLICT (setting_key)
       DO UPDATE SET setting_value = EXCLUDED.setting_value,
                     description = EXCLUDED.description`,
      []
    );

    console.log('OK:  sms marketing schema ready');
  } catch (err) {
    console.error('ERROR:  ensureSmsMarketingSchema failed:', err.message);
  }
})();

