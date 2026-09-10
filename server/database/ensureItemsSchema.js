/**
 * Ensures items + branch_item_prices tables exist on PostgreSQL and
 * populates the SUPACLEAN price list.
 * Run at server startup so the Price List page works without manual SQL
 * (mirrors scripts/migrate-items-simple.sql + scripts/populate-items.sql).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

// SUPACLEAN price list (name, category, base_price TSh, service_type)
const PRICE_LIST_ITEMS = require('./itemsPriceList');

async function ensure() {
  try {
    await db.run(
      `CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL DEFAULT 'general',
        base_price DECIMAL(10,2) NOT NULL DEFAULT 0,
        service_type TEXT NOT NULL DEFAULT 'Wash, Press & Hanged',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      []
    );

    await db.run(
      `CREATE TABLE IF NOT EXISTS branch_item_prices (
        id SERIAL PRIMARY KEY,
        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(branch_id, item_id)
      )`,
      []
    );

    // FK: branch_item_prices.item_id -> items(id) (skip if already present)
    await db.run(
      `DO $$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_item_prices_item_id_fkey') THEN
           ALTER TABLE branch_item_prices
             ADD CONSTRAINT branch_item_prices_item_id_fkey
             FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE;
         END IF;
       END $$`,
      []
    );

    // UNIQUE(items.name) so price-list population can use ON CONFLICT (name)
    await db.run(
      `DO $$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_name_unique') THEN
           ALTER TABLE items ADD CONSTRAINT items_name_unique UNIQUE (name);
         END IF;
       END $$`,
      []
    );

    // orders.item_id (nullable) + FK + index for the items/services separation
    await db.run('ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_id INTEGER', []);
    await db.run(
      `DO $$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_item') THEN
           ALTER TABLE orders ADD CONSTRAINT fk_orders_item
             FOREIGN KEY (item_id) REFERENCES items(id);
         END IF;
       END $$`,
      []
    );

    await db.run('CREATE INDEX IF NOT EXISTS idx_items_category ON items(category)', []);
    await db.run('CREATE INDEX IF NOT EXISTS idx_items_active ON items(is_active)', []);
    await db.run('CREATE INDEX IF NOT EXISTS idx_branch_item_prices_branch ON branch_item_prices(branch_id)', []);
    await db.run('CREATE INDEX IF NOT EXISTS idx_branch_item_prices_item ON branch_item_prices(item_id)', []);
    await db.run('CREATE INDEX IF NOT EXISTS idx_orders_item ON orders(item_id)', []);

    // Populate the price list (idempotent — existing names are left as-is)
    const before = await db.get('SELECT COUNT(*)::int AS n FROM items');
    const values = [];
    const params = [];
    PRICE_LIST_ITEMS.forEach(([name, category, basePrice, serviceType]) => {
      const base = params.length;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(name, category, basePrice, serviceType);
    });
    await db.run(
      `INSERT INTO items (name, category, base_price, service_type)
       VALUES ${values.join(', ')}
       ON CONFLICT (name) DO NOTHING`,
      params
    );

    // NOTE: the full scripts/migrate-items-simple.sql also rewrites `services`
    // to 3 delivery types (Regular/Express). That step is intentionally NOT
    // repeated here: existing orders reference current services via
    // fk_orders_service_id, so deleting services would break them. Run that
    // step manually only before seeding/orders exist.
    const count = await db.get('SELECT COUNT(*)::int AS n FROM items');
    console.log(`OK:  Items schema ready (${count.n} price-list items, ${count.n - before.n} newly populated)`);
  } catch (err) {
    console.error('ERROR:  Items schema migration error:', err.message);
  }
}

ensure();
