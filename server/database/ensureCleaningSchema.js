/**
 * Ensures cleaning services tables exist on PostgreSQL (cleaning_customers, documents, payments, expenses).
 * Matches scripts/cleaning-services-full-schema.sql so hosted DBs do not miss migrations after deploy.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) return;

const db = require('./query');

async function tableExists(name) {
  const row = await db.get(
    `SELECT 1 AS ok FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ?`,
    [name]
  );
  return !!row;
}

async function columnExists(table, column) {
  const row = await db.get(
    `SELECT 1 AS ok FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return !!row;
}

async function ensure() {
  try {
    await db.run(
      `CREATE TABLE IF NOT EXISTS cleaning_customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT,
        address TEXT,
        tin TEXT,
        branch_id INTEGER REFERENCES branches(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_cleaning_customers_branch ON cleaning_customers(branch_id)',
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_cleaning_customers_phone ON cleaning_customers(phone)',
      []
    );

    const hasDocs = await tableExists('cleaning_documents');
    if (!hasDocs) {
      await db.run(
        `CREATE TABLE cleaning_documents (
          id SERIAL PRIMARY KEY,
          document_type TEXT NOT NULL CHECK (document_type IN ('quotation', 'invoice')),
          document_number TEXT NOT NULL UNIQUE,
          cleaning_customer_id INTEGER NOT NULL REFERENCES cleaning_customers(id),
          document_date DATE NOT NULL DEFAULT CURRENT_DATE,
          due_date DATE,
          subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
          total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
          paid_amount DECIMAL(10,2) DEFAULT 0,
          balance_due DECIMAL(10,2),
          notes TEXT,
          branch_id INTEGER REFERENCES branches(id),
          created_by TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        []
      );
      await db.run(
        'CREATE INDEX IF NOT EXISTS idx_cleaning_documents_date ON cleaning_documents(document_date DESC)',
        []
      );
      await db.run(
        'CREATE INDEX IF NOT EXISTS idx_cleaning_documents_type ON cleaning_documents(document_type)',
        []
      );
      await db.run(
        'CREATE INDEX IF NOT EXISTS idx_cleaning_documents_cleaning_customer ON cleaning_documents(cleaning_customer_id)',
        []
      );
    } else {
      await db.run(
        'ALTER TABLE cleaning_documents ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(10,2) DEFAULT 0',
        []
      );
      await db.run(
        'ALTER TABLE cleaning_documents ADD COLUMN IF NOT EXISTS balance_due DECIMAL(10,2)',
        []
      );

      const hasLegacyCustomer = await columnExists('cleaning_documents', 'customer_id');
      const hasCleaningCustomer = await columnExists('cleaning_documents', 'cleaning_customer_id');

      if (hasLegacyCustomer) {
        if (!hasCleaningCustomer) {
          await db.run(
            'ALTER TABLE cleaning_documents ADD COLUMN cleaning_customer_id INTEGER REFERENCES cleaning_customers(id)',
            []
          );
        }
        await db.query(`
          INSERT INTO cleaning_customers (name, phone, email, address, branch_id)
          SELECT DISTINCT c.name, c.phone, c.email, c.address, cd.branch_id
          FROM customers c
          INNER JOIN cleaning_documents cd ON cd.customer_id = c.id
          WHERE NOT EXISTS (
            SELECT 1 FROM cleaning_customers cc
            WHERE cc.phone = c.phone
              AND (cc.branch_id = cd.branch_id OR (cc.branch_id IS NULL AND cd.branch_id IS NULL))
          )
        `);
        await db.query(`
          UPDATE cleaning_documents cd
          SET cleaning_customer_id = cc.id
          FROM customers c, cleaning_customers cc
          WHERE cd.customer_id = c.id
            AND cd.cleaning_customer_id IS NULL
            AND cc.phone = c.phone
            AND (cc.branch_id = cd.branch_id OR (cc.branch_id IS NULL AND cd.branch_id IS NULL))
        `);
        await db.run(
          'ALTER TABLE cleaning_documents DROP CONSTRAINT IF EXISTS cleaning_documents_customer_id_fkey',
          []
        );
        await db.run('ALTER TABLE cleaning_documents DROP COLUMN IF EXISTS customer_id', []);
      } else if (!hasCleaningCustomer) {
        await db.run(
          'ALTER TABLE cleaning_documents ADD COLUMN IF NOT EXISTS cleaning_customer_id INTEGER REFERENCES cleaning_customers(id)',
          []
        );
      }

      await db.run(
        'CREATE INDEX IF NOT EXISTS idx_cleaning_documents_cleaning_customer ON cleaning_documents(cleaning_customer_id)',
        []
      );
      await db.run(
        'DROP INDEX IF EXISTS idx_cleaning_documents_customer',
        []
      );
    }

    await db.run(
      `CREATE TABLE IF NOT EXISTS cleaning_document_items (
        id SERIAL PRIMARY KEY,
        cleaning_document_id INTEGER NOT NULL REFERENCES cleaning_documents(id) ON DELETE CASCADE,
        line_number INTEGER NOT NULL DEFAULT 1,
        service_type TEXT,
        description TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
        total_amount DECIMAL(10,2) NOT NULL DEFAULT 0
      )`,
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_cleaning_document_items_doc ON cleaning_document_items(cleaning_document_id)',
      []
    );

    await db.run(
      `CREATE TABLE IF NOT EXISTS cleaning_payments (
        id SERIAL PRIMARY KEY,
        cleaning_document_id INTEGER NOT NULL REFERENCES cleaning_documents(id) ON DELETE CASCADE,
        amount DECIMAL(10,2) NOT NULL,
        payment_date DATE NOT NULL,
        payment_method TEXT DEFAULT 'cash',
        reference_number TEXT,
        notes TEXT,
        branch_id INTEGER REFERENCES branches(id),
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_cleaning_payments_doc ON cleaning_payments(cleaning_document_id)',
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_cleaning_payments_date ON cleaning_payments(payment_date)',
      []
    );

    await db.run(
      `CREATE TABLE IF NOT EXISTS cleaning_expenses (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        category TEXT NOT NULL,
        description TEXT,
        amount DECIMAL(10,2) NOT NULL,
        branch_id INTEGER REFERENCES branches(id),
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_cleaning_expenses_date ON cleaning_expenses(date)',
      []
    );
    await db.run(
      'CREATE INDEX IF NOT EXISTS idx_cleaning_expenses_branch ON cleaning_expenses(branch_id)',
      []
    );

    await db.query(`
      UPDATE cleaning_documents
      SET balance_due = total_amount - COALESCE(paid_amount, 0)
      WHERE balance_due IS NULL AND total_amount IS NOT NULL
    `);

    console.log('OK:  Cleaning services schema ready');
  } catch (err) {
    console.error('ERROR:  Cleaning services schema migration error:', err.message);
  }
}

ensure();
