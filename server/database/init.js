const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Ensure database directory exists
const dbDir = path.join(__dirname, '../../database');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'supaclean.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('OK:  Connected to SQLite database');
    // Enable WAL mode for better performance and concurrency
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');
    db.run('PRAGMA cache_size = -64000;'); // 64MB cache
    db.run('PRAGMA temp_store = MEMORY;');
    db.run('PRAGMA mmap_size = 268435456;'); // 256MB memory-mapped I/O
    db.run('PRAGMA foreign_keys = ON;'); // Enable foreign key constraints
    // Serialize schema setup: this SQLite driver executes statements on a
    // background thread. Wrapping the whole setup in db.serialize() guarantees
    // the CREATE TABLE statements finish before migrateDatabase()/createIndexes()
    // run, which would otherwise crash on a fresh database ("no such table/column").
    db.serialize(() => {
      initializeTables();
    });
  }
});

function initializeTables() {
  // Customers table
  db.run(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT,
    address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Services table
  db.run(`CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    base_price REAL NOT NULL DEFAULT 0,
    price_per_item REAL DEFAULT 0,
    price_per_kg REAL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, () => {
    // Insert default services
    insertDefaultServices();
  });

  // Orders table
  // Note: receipt_number is NOT UNIQUE to allow multiple items per receipt
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_number TEXT NOT NULL,
    customer_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    garment_type TEXT,
    color TEXT,
    quantity INTEGER DEFAULT 1,
    weight_kg REAL,
    special_instructions TEXT,
    delivery_type TEXT DEFAULT 'standard',
    express_surcharge_multiplier REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    total_amount REAL NOT NULL,
    paid_amount REAL DEFAULT 0,
    payment_status TEXT DEFAULT 'not_paid',
    payment_method TEXT DEFAULT 'cash',
    order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    ready_date DATETIME,
    collected_date DATETIME,
    created_by TEXT,
    is_voided INTEGER DEFAULT 0,
    void_reason TEXT,
    voided_by TEXT,
    voided_at DATETIME,
    archived_at DATETIME,
    archived_by TEXT,
    archive_reason TEXT,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (service_id) REFERENCES services(id)
  )`);

  // Settings table for express service configuration
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key TEXT UNIQUE NOT NULL,
    setting_value TEXT NOT NULL,
    description TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, () => {
    // Insert default settings
    insertDefaultSettings();
  });

  // Transactions table (for cash management)
  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    transaction_type TEXT NOT NULL,
    amount REAL NOT NULL,
    payment_method TEXT DEFAULT 'cash',
    description TEXT,
    transaction_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id)
  )`);

  // Daily Cash Summaries table
  db.run(`CREATE TABLE IF NOT EXISTS daily_cash_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    opening_balance REAL DEFAULT 0,
    cash_sales REAL DEFAULT 0,
    book_sales REAL DEFAULT 0,
    card_sales REAL DEFAULT 0,
    mobile_money_sales REAL DEFAULT 0,
    credit_sales REAL DEFAULT 0,
    bank_deposits REAL DEFAULT 0,
    bank_payments REAL DEFAULT 0,
    mpesa_received REAL DEFAULT 0,
    mpesa_paid REAL DEFAULT 0,
    expenses_from_cash REAL DEFAULT 0,
    expenses_from_bank REAL DEFAULT 0,
    expenses_from_mpesa REAL DEFAULT 0,
    cash_in_hand REAL DEFAULT 0,
    closing_balance REAL DEFAULT 0,
    is_reconciled INTEGER DEFAULT 0,
    reconciled_by TEXT,
    reconciled_at DATETIME,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Expenses table
  db.run(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    payment_source TEXT NOT NULL,
    description TEXT,
    receipt_number TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Bank Accounts table (admin-managed list for deposit dropdown)
  db.run(`CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    account_number TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Bank Deposits table
  db.run(`CREATE TABLE IF NOT EXISTS bank_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    reference_number TEXT,
    bank_name TEXT,
    notes TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Notifications table (for tracking SMS/notifications sent to customers)
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    order_id INTEGER,
    notification_type TEXT NOT NULL,
    channel TEXT DEFAULT 'sms',
    recipient TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    sent_at DATETIME,
    error_message TEXT,
    dedupe_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  )`);

  // SMS marketing templates (admin-managed message templates)
  db.run(`CREATE TABLE IF NOT EXISTS sms_marketing_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    message TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // SMS marketing campaign runs (one row per send action)
  db.run(`CREATE TABLE IF NOT EXISTS sms_marketing_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    template_id INTEGER NOT NULL,
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (template_id) REFERENCES sms_marketing_templates(id)
  )`);

  // Loyalty Points table
  db.run(`CREATE TABLE IF NOT EXISTS loyalty_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL UNIQUE,
    current_points INTEGER DEFAULT 0,
    lifetime_points INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'Bronze',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  )`);

  // Loyalty Transactions table
  db.run(`CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    order_id INTEGER,
    transaction_type TEXT NOT NULL,
    points INTEGER NOT NULL,
    description TEXT,
    balance_after INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  )`);

  // Loyalty Rewards table
  db.run(`CREATE TABLE IF NOT EXISTS loyalty_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    points_required INTEGER NOT NULL,
    discount_percentage REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0,
    service_value REAL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Branches table (Multi-branch support)
  db.run(`CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    branch_type TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    manager_name TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, () => {
    // Insert default main branch if it doesn't exist
    db.run(`INSERT OR IGNORE INTO branches (name, code, branch_type, address, is_active) 
            VALUES ('Main Branch', 'AR01', 'workshop', 'Arusha, Tanzania', 1)`, (err) => {
      if (!err) {
        console.log('OK:  Default main branch created');
      }
    });
  });

  // Branch Features table (Feature flags per branch)
  db.run(`CREATE TABLE IF NOT EXISTS branch_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL,
    feature_key TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    UNIQUE(branch_id, feature_key)
  )`);

  // Users table (Authentication & Authorization)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT,
    branch_id INTEGER,
    role TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    FOREIGN KEY (branch_id) REFERENCES branches(id)
  )`);

  // Order Transfers table (Track orders moving between branches)
  db.run(`CREATE TABLE IF NOT EXISTS order_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    from_branch_id INTEGER,
    to_branch_id INTEGER NOT NULL,
    transfer_type TEXT NOT NULL,
    transferred_by INTEGER,
    transfer_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (from_branch_id) REFERENCES branches(id),
    FOREIGN KEY (to_branch_id) REFERENCES branches(id),
    FOREIGN KEY (transferred_by) REFERENCES users(id)
  )`);

  // User Sessions table (for authentication)
  db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_token TEXT NOT NULL UNIQUE,
    branch_id INTEGER,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (branch_id) REFERENCES branches(id)
  )`);

  // Payment Audit Log table (for tracking payment changes)
  db.run(`CREATE TABLE IF NOT EXISTS payment_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    old_payment_status TEXT,
    new_payment_status TEXT,
    old_paid_amount REAL,
    new_paid_amount REAL,
    old_payment_method TEXT,
    new_payment_method TEXT,
    changed_by TEXT,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id)
  )`);

  console.log('OK:  Database tables initialized');
  // Migrate existing database if needed
  migrateDatabase();
  
  // Create indexes for performance
  createIndexes();
  
  // Create default admin user after tables are ready
  setTimeout(() => {
    const { createDefaultAdmin } = require('../utils/createDefaultAdmin');
    createDefaultAdmin();
  }, 1000);
}

function createIndexes() {
  console.log('Creating database indexes for performance...');
  
  // Orders table indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_receipt_number ON orders(receipt_number)');
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status)');
  // NOTE: idx_orders_estimated_collection is created below after a PRAGMA check, because
  // estimated_collection_date is added asynchronously by migrateDatabase() and may not
  // exist yet on a fresh SQLite database when createIndexes() runs.
  
  // Customers table indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)');
  db.run('CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name)');
  
  // Transactions table indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_transactions_order_id ON transactions(order_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type)');
  
  // User sessions indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at)');
  
  // Payment-related indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_payment_date ON orders(payment_status, payment_method, order_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_transactions_payment_date ON transactions(transaction_type, payment_method, transaction_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_payment_audit_order ON payment_audit_log(order_id, changed_at)');
  
  // Check if branch_id exists in orders table before creating index
  db.all("PRAGMA table_info(orders)", [], (err, columns) => {
    if (!err && columns.some(col => col.name === 'estimated_collection_date')) {
      db.run('CREATE INDEX IF NOT EXISTS idx_orders_estimated_collection ON orders(estimated_collection_date)');
    }
    if (!err && columns.some(col => col.name === 'branch_id')) {
      db.run('CREATE INDEX IF NOT EXISTS idx_orders_branch_id ON orders(branch_id)');
    }
    if (!err && columns.some(col => col.name === 'archived_at')) {
      db.run('CREATE INDEX IF NOT EXISTS idx_orders_archived_at ON orders(archived_at)');
      if (columns.some(col => col.name === 'status') && columns.some(col => col.name === 'branch_id')) {
        db.run('CREATE INDEX IF NOT EXISTS idx_orders_branch_archived_status ON orders(branch_id, archived_at, status)');
      }
    }
  });
  
  console.log('OK:  Database indexes created');
}

function migrateDatabase() {
  // Ensure "Pressing only" and "Drying only" exist for existing DBs (new installs get them from insertDefaultServices)
  db.run(`INSERT OR IGNORE INTO services (name, description, base_price, price_per_item, price_per_kg) VALUES (?, ?, ?, ?, ?)`,
    ['Pressing only', 'Ironing / press only', 2000, 2000, 0]);
  db.run(`INSERT OR IGNORE INTO services (name, description, base_price, price_per_item, price_per_kg) VALUES (?, ?, ?, ?, ?)`,
    ['Drying only', 'Tumble dry only', 3000, 0, 3000]);

  // Add new columns to orders table if they don't exist
  db.serialize(() => {
    db.all("PRAGMA table_info(orders)", [], (err, columns) => {
      if (err) {
        console.error('Error checking table info:', err);
        return;
      }
      
      const columnNames = columns.map(col => col.name);
      const migrations = [];
      
      if (!columnNames.includes('delivery_type')) {
        migrations.push("ALTER TABLE orders ADD COLUMN delivery_type TEXT DEFAULT 'standard'");
      }
      if (!columnNames.includes('express_surcharge_multiplier')) {
        migrations.push("ALTER TABLE orders ADD COLUMN express_surcharge_multiplier REAL DEFAULT 0");
      }
      if (!columnNames.includes('payment_status')) {
        migrations.push("ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'not_paid'");
      }
      if (!columnNames.includes('estimated_collection_date')) {
        migrations.push("ALTER TABLE orders ADD COLUMN estimated_collection_date DATETIME");
      }
      if (!columnNames.includes('branch_id')) {
        migrations.push("ALTER TABLE orders ADD COLUMN branch_id INTEGER");
      }
      if (!columnNames.includes('created_at_branch_id')) {
        migrations.push("ALTER TABLE orders ADD COLUMN created_at_branch_id INTEGER");
      }
      if (!columnNames.includes('ready_at_branch_id')) {
        migrations.push("ALTER TABLE orders ADD COLUMN ready_at_branch_id INTEGER");
      }
      if (!columnNames.includes('collected_at_branch_id')) {
        migrations.push("ALTER TABLE orders ADD COLUMN collected_at_branch_id INTEGER");
      }
      if (!columnNames.includes('is_voided')) {
        migrations.push('ALTER TABLE orders ADD COLUMN is_voided INTEGER DEFAULT 0');
      }
      if (!columnNames.includes('void_reason')) {
        migrations.push('ALTER TABLE orders ADD COLUMN void_reason TEXT');
      }
      if (!columnNames.includes('voided_by')) {
        migrations.push('ALTER TABLE orders ADD COLUMN voided_by TEXT');
      }
      if (!columnNames.includes('voided_at')) {
        migrations.push('ALTER TABLE orders ADD COLUMN voided_at DATETIME');
      }
      if (!columnNames.includes('archived_at')) {
        migrations.push('ALTER TABLE orders ADD COLUMN archived_at DATETIME');
      }
      if (!columnNames.includes('archived_by')) {
        migrations.push('ALTER TABLE orders ADD COLUMN archived_by TEXT');
      }
      if (!columnNames.includes('archive_reason')) {
        migrations.push('ALTER TABLE orders ADD COLUMN archive_reason TEXT');
      }
      
      // Check and create loyalty tables if they don't exist
      db.run(`CREATE TABLE IF NOT EXISTS loyalty_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL UNIQUE,
        current_points INTEGER DEFAULT 0,
        lifetime_points INTEGER DEFAULT 0,
        tier TEXT DEFAULT 'Bronze',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      )`);
      
      db.run(`CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        order_id INTEGER,
        transaction_type TEXT NOT NULL,
        points INTEGER NOT NULL,
        description TEXT,
        balance_after INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id),
        FOREIGN KEY (order_id) REFERENCES orders(id)
      )`);
      
      db.run(`CREATE TABLE IF NOT EXISTS loyalty_rewards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        points_required INTEGER NOT NULL,
        discount_percentage REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        service_value REAL DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      
      // SMS de-duplication key (SQLite; PostgreSQL uses ensureNotificationsDedupeKey.js)
      db.all("PRAGMA table_info(notifications)", [], (notifErr, notifColumns) => {
        if (!notifErr && notifColumns) {
          const notifNames = notifColumns.map((col) => col.name);
          if (!notifNames.includes('dedupe_key')) {
            db.run('ALTER TABLE notifications ADD COLUMN dedupe_key TEXT', (alterErr) => {
              if (!alterErr) console.log('OK:  Added dedupe_key column to notifications');
            });
          }
        }
      });

      db.all("PRAGMA table_info(users)", [], (userColErr, userCols) => {
        if (!userColErr && userCols) {
          const names = userCols.map((c) => c.name);
          if (!names.includes('email')) {
            db.run('ALTER TABLE users ADD COLUMN email TEXT', (alterErr) => {
              if (!alterErr) console.log('OK:  Added email column to users (SQLite)');
            });
          }
          if (!names.includes('must_change_password')) {
            db.run('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0', (alterErr) => {
              if (!alterErr) console.log('OK:  Added must_change_password column to users (SQLite)');
            });
          }
          if (!names.includes('updated_at')) {
            db.run('ALTER TABLE users ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP', (alterErr) => {
              if (!alterErr) console.log('OK:  Added updated_at column to users (SQLite)');
            });
          }
        }
      });

      // Add notification preferences and tags to customers table
      db.all("PRAGMA table_info(customers)", [], (customerErr, customerColumns) => {
        if (!customerErr && customerColumns) {
          const customerColumnNames = customerColumns.map(col => col.name);
          if (!customerColumnNames.includes('sms_notifications_enabled')) {
            db.run("ALTER TABLE customers ADD COLUMN sms_notifications_enabled INTEGER DEFAULT 1", (alterErr) => {
              if (!alterErr) {
                console.log('OK:  Added sms_notifications_enabled column to customers');
              } else {
                console.log('Note: sms_notifications_enabled column may already exist');
              }
            });
          }
          if (!customerColumnNames.includes('tags')) {
            db.run("ALTER TABLE customers ADD COLUMN tags TEXT", (alterErr) => {
              if (!alterErr) {
                console.log('OK:  Added tags column to customers');
              } else {
                console.log('Note: tags column may already exist');
              }
            });
          }
        }
      });
      
      // Remove UNIQUE constraint from receipt_number to allow multiple items per receipt
      // SQLite creates implicit unique indexes, we need to drop all of them
      db.all("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='orders'", [], (indexErr, indexes) => {
        if (!indexErr && indexes) {
          indexes.forEach(idx => {
            // Drop any auto-generated unique indexes (SQLite creates these for UNIQUE constraints)
            if (idx.name && (idx.name.includes('receipt_number') || idx.name.startsWith('sqlite_autoindex'))) {
              db.run(`DROP INDEX IF EXISTS ${idx.name}`, (dropErr) => {
                if (dropErr) {
                  console.log(`Note: Could not drop index ${idx.name}:`, dropErr.message);
                } else {
                  console.log(`OK:  Dropped index: ${idx.name}`);
                }
              });
            }
          });
          
          // Also try to drop the specific autoindex if it exists
          db.run("DROP INDEX IF EXISTS sqlite_autoindex_orders_1", (dropErr) => {
            if (!dropErr) {
              console.log('OK:  Removed sqlite_autoindex_orders_1');
            }
          });
        }
      });
      
      // Verify no unique constraint exists by checking the table schema
      db.all("PRAGMA index_list('orders')", [], (listErr, indexList) => {
        if (!listErr && indexList) {
          indexList.forEach(idx => {
            if (idx.unique === 1) {
              console.log(`WARN: ️  Warning: Unique index found: ${idx.name}`);
            }
          });
        }
      });
      
      // Add branch_id to customers table
      db.all("PRAGMA table_info(customers)", [], (customerInfoErr, customerInfoColumns) => {
        if (!customerInfoErr && customerInfoColumns) {
          const customerInfoColumnNames = customerInfoColumns.map(col => col.name);
          if (!customerInfoColumnNames.includes('primary_branch_id')) {
            db.run("ALTER TABLE customers ADD COLUMN primary_branch_id INTEGER", (alterErr) => {
              if (!alterErr) {
                console.log('OK:  Added primary_branch_id column to customers');
              }
            });
          }
        }
      });

      // Add branch_id to transactions table
      db.all("PRAGMA table_info(transactions)", [], (transErr, transColumns) => {
        if (!transErr && transColumns) {
          const transColumnNames = transColumns.map(col => col.name);
          if (!transColumnNames.includes('branch_id')) {
            db.run("ALTER TABLE transactions ADD COLUMN branch_id INTEGER", (alterErr) => {
              if (!alterErr) {
                console.log('OK:  Added branch_id column to transactions');
              }
            });
          }
          if (!transColumnNames.includes('is_voided')) {
            db.run('ALTER TABLE transactions ADD COLUMN is_voided INTEGER DEFAULT 0');
          }
          if (!transColumnNames.includes('void_reason')) {
            db.run('ALTER TABLE transactions ADD COLUMN void_reason TEXT');
          }
          if (!transColumnNames.includes('voided_by')) {
            db.run('ALTER TABLE transactions ADD COLUMN voided_by TEXT');
          }
          if (!transColumnNames.includes('voided_at')) {
            db.run('ALTER TABLE transactions ADD COLUMN voided_at DATETIME');
          }
        }
      });

      // Add branch_id and bank-deposit fields to expenses table
      db.all("PRAGMA table_info(expenses)", [], (expErr, expColumns) => {
        if (!expErr && expColumns) {
          const expColumnNames = expColumns.map(col => col.name);
          if (!expColumnNames.includes('branch_id')) {
            db.run("ALTER TABLE expenses ADD COLUMN branch_id INTEGER", (alterErr) => {
              if (!alterErr) console.log('OK:  Added branch_id column to expenses');
            });
          }
          if (!expColumnNames.includes('bank_account_id')) {
            db.run("ALTER TABLE expenses ADD COLUMN bank_account_id INTEGER", (alterErr) => {
              if (!alterErr) console.log('OK:  Added bank_account_id to expenses');
            });
          }
          if (!expColumnNames.includes('deposit_reference_number')) {
            db.run("ALTER TABLE expenses ADD COLUMN deposit_reference_number TEXT", (alterErr) => {
              if (!alterErr) console.log('OK:  Added deposit_reference_number to expenses');
            });
          }
          if (!expColumnNames.includes('bank_deposit_id')) {
            db.run("ALTER TABLE expenses ADD COLUMN bank_deposit_id INTEGER", (alterErr) => {
              if (!alterErr) console.log('OK:  Added bank_deposit_id to expenses');
            });
          }
        }
      });

      // Add branch_id to bank_deposits table
      db.all("PRAGMA table_info(bank_deposits)", [], (bankErr, bankColumns) => {
        if (!bankErr && bankColumns) {
          const bankColumnNames = bankColumns.map(col => col.name);
          if (!bankColumnNames.includes('branch_id')) {
            db.run("ALTER TABLE bank_deposits ADD COLUMN branch_id INTEGER", (alterErr) => {
              if (!alterErr) {
                console.log('OK:  Added branch_id column to bank_deposits');
              }
            });
          }
          if (!bankColumnNames.includes('bank_account_id')) {
            db.run("ALTER TABLE bank_deposits ADD COLUMN bank_account_id INTEGER", (alterErr) => {
              if (!alterErr) {
                console.log('OK:  Added bank_account_id column to bank_deposits');
              }
            });
          }
        }
      });

      // Add branch_id to daily_cash_summaries (for reconcile and multi-branch cash)
      db.all("PRAGMA table_info(daily_cash_summaries)", [], (dcsErr, dcsColumns) => {
        if (!dcsErr && dcsColumns) {
          const dcsColumnNames = dcsColumns.map(col => col.name);
          if (!dcsColumnNames.includes('branch_id')) {
            db.run("ALTER TABLE daily_cash_summaries ADD COLUMN branch_id INTEGER", (alterErr) => {
              if (!alterErr) {
                console.log('OK:  Added branch_id column to daily_cash_summaries');
              }
            });
          }
          if (!dcsColumnNames.includes('reconciled_closing_balance')) {
            db.run("ALTER TABLE daily_cash_summaries ADD COLUMN reconciled_closing_balance REAL", (alterErr) => {
              if (!alterErr) {
                console.log('OK:  Added reconciled_closing_balance to daily_cash_summaries');
                db.run(
                  `UPDATE daily_cash_summaries SET reconciled_closing_balance = closing_balance
                   WHERE COALESCE(is_reconciled, 0) = 1 AND reconciled_closing_balance IS NULL`,
                  () => {}
                );
              }
            });
          }
          if (!dcsColumnNames.includes('credit_sales')) {
            db.run("ALTER TABLE daily_cash_summaries ADD COLUMN credit_sales REAL DEFAULT 0", (alterErr) => {
              if (!alterErr) {
                console.log('OK:  Added credit_sales column to daily_cash_summaries');
              }
            });
          }
        }
      });

      // Migrate loyalty_rewards table - add service_value column if missing
      db.all("PRAGMA table_info(loyalty_rewards)", [], (rewardsErr, rewardsColumns) => {
        if (!rewardsErr && rewardsColumns) {
          const rewardsColumnNames = rewardsColumns.map(col => col.name);
          if (!rewardsColumnNames.includes('service_value')) {
            db.run("ALTER TABLE loyalty_rewards ADD COLUMN service_value REAL DEFAULT 0", (alterErr) => {
              if (!alterErr) {
                console.log('OK:  Added service_value column to loyalty_rewards');
              } else {
                console.log('Note: service_value column migration:', alterErr.message);
              }
              // After migration, insert default reward
              insertDefaultLoyaltyReward();
            });
          } else {
            // Column exists, insert default reward
            insertDefaultLoyaltyReward();
          }
        } else {
          // Can't check columns, try to insert anyway (table might not exist yet)
          setTimeout(() => insertDefaultLoyaltyReward(), 500);
        }
      });
      
      function insertDefaultLoyaltyReward() {
        // Insert default reward: 100 points = Free wash worth 10,000 TSh
        // Try with service_value first
        db.run(`INSERT OR IGNORE INTO loyalty_rewards (name, description, points_required, service_value, discount_amount) VALUES
          ('Free Wash', 'Free wash service worth TSh 10,000', 100, 10000, 10000)`, (insertErr) => {
          if (insertErr) {
            // If service_value column doesn't exist yet, try without it
            if (insertErr.message.includes('service_value') || insertErr.message.includes('no such column')) {
              db.run(`INSERT OR IGNORE INTO loyalty_rewards (name, description, points_required, discount_amount) VALUES
                ('Free Wash', 'Free wash service worth TSh 10,000', 100, 10000)`, (retryErr) => {
                if (retryErr) {
                  console.error('Error inserting default reward:', retryErr.message);
                }
              });
            } else {
              console.error('Error inserting default reward:', insertErr.message);
            }
          }
        });
      }
      
      if (migrations.length > 0) {
        console.log('SYNC:  Migrating database schema...');
        migrations.forEach((migration, index) => {
          db.run(migration, (err) => {
            if (err) {
              console.error(`Error running migration ${index + 1}:`, err);
            } else {
              console.log(`OK:  Migration ${index + 1} completed`);
            }
            if (index === migrations.length - 1) {
              console.log('OK:  Database migration completed');
              // After migrations, assign existing data to default branch
              assignDataToDefaultBranch();
            }
          });
        });
      } else {
        // No migrations needed, but still check if we need to assign data to default branch
        assignDataToDefaultBranch();
      }
      
      function assignDataToDefaultBranch() {
        // Get or create default branch
        db.get("SELECT id FROM branches WHERE code = 'AR01' LIMIT 1", [], (branchErr, branch) => {
          if (!branchErr && branch) {
            const defaultBranchId = branch.id;
            
            // Assign existing orders to default branch
            db.run("UPDATE orders SET branch_id = ?, created_at_branch_id = ? WHERE branch_id IS NULL", 
              [defaultBranchId, defaultBranchId], (orderErr) => {
              if (!orderErr) {
                console.log('OK:  Assigned existing orders to default branch');
              }
            });
            
            // Assign existing transactions to default branch
            db.run("UPDATE transactions SET branch_id = ? WHERE branch_id IS NULL", 
              [defaultBranchId], (transErr) => {
              if (!transErr) {
                console.log('OK:  Assigned existing transactions to default branch');
              }
            });
            
            // Assign existing expenses to default branch
            db.run("UPDATE expenses SET branch_id = ? WHERE branch_id IS NULL", 
              [defaultBranchId], (expErr) => {
              if (!expErr) {
                console.log('OK:  Assigned existing expenses to default branch');
              }
            });
            
            // Assign existing bank deposits to default branch
            db.run("UPDATE bank_deposits SET branch_id = ? WHERE branch_id IS NULL", 
              [defaultBranchId], (bankErr) => {
              if (!bankErr) {
                console.log('OK:  Assigned existing bank deposits to default branch');
              }
            });
          }
        });
      }
    });
  });
}

function insertDefaultServices() {
  // Service types: pressing only, drying only (Wash only / Wash & Fold per kg = use "Wash Only 1KG" and "Wash & Dry 1KG" below)
  const serviceTypes = [
    { name: 'Pressing only', description: 'Ironing / press only', base_price: 2000, price_per_item: 2000 },
    { name: 'Drying only', description: 'Tumble dry only', base_price: 3000, price_per_kg: 3000 },
  ];
  // GENTS Services
  const gentsServices = [
    { name: 'Suit 2 pcs', description: 'Wash, Press & Hanged', base_price: 11000 },
    { name: 'Suit 3 pcs', description: 'Wash, Press & Hanged', base_price: 13000 },
    { name: 'Coats', description: 'Wash, Press & Hanged', base_price: 6000 },
    { name: 'Velvet/Wool Coat', description: 'Wash, Press & Hanged', base_price: 6000 },
    { name: 'Sued Coat', description: 'Wash, Press & Hanged', base_price: 5000 },
    { name: 'Kaunda/Safari Suit', description: 'Wash, Press & Hanged', base_price: 9000 },
    { name: 'Pyjama suits', description: 'Wash, Press & Hanged', base_price: 7000 },
    { name: 'Trousers', description: 'Wash, Press & Hanged', base_price: 4000 },
    { name: 'Nigerian Suit Unstarched', description: 'Wash, Press & Hanged', base_price: 9000 },
    { name: 'Nigerian Suit Starched', description: 'Wash, Press & Hanged', base_price: 11000 },
    { name: 'Leather Jackets', description: 'Wash, Press & Hanged', base_price: 15000 },
    { name: 'Jackets', description: 'Wash, Press & Hanged', base_price: 6000 },
    { name: 'Spy Coats/Long Coat', description: 'Wash, Press & Hanged', base_price: 7000 },
    { name: 'Shorts', description: 'Wash, Press & Hanged', base_price: 3000 },
    { name: 'Shirts - Colored', description: 'Wash, Press & Hanged', base_price: 2000 },
    { name: 'Shirts - White', description: 'Wash, Press & Hanged', base_price: 3000 },
    { name: 'Pants/Boxers', description: 'Wash, Press & Hanged', base_price: 3000 },
    { name: 'Vests/Tie', description: 'Wash, Press & Hanged', base_price: 1000 },
    { name: 'Overall', description: 'Wash, Press & Hanged', base_price: 6000 },
    { name: 'Caps', description: 'Wash, Press & Hanged', base_price: 2000 },
    { name: 'Car Seat Covers', description: 'Wash & Fold', base_price: 20000 },
    { name: 'Curtains Standard', description: 'Wash, Press & Fold', base_price: 5000 },
    { name: 'Curtains Heavy', description: 'Wash, Press & Fold', base_price: 6000 },
    { name: 'Curtains Light', description: 'Wash, Press & Fold', base_price: 3000 },
    { name: 'Blankets', description: 'Wash & Fold', base_price: 9000 },
    { name: 'Shoes', description: 'Cleaning', base_price: 3000 },
    { name: 'Carpets', description: 'Wash & Fold (10,000 - 50,000)', base_price: 10000 }
  ];

  // LADIES Services
  const ladiesServices = [
    { name: 'Lady Suit 2 pcs', description: 'Wash, Press & Hanged', base_price: 8000 },
    { name: 'Trouser/Skirt Suit 3pcs', description: 'Wash, Press & Hanged', base_price: 9000 },
    { name: 'Kitenge Suit', description: 'Wash, Press & Hanged', base_price: 8000 },
    { name: 'Lady Coat', description: 'Wash, Press & Hanged', base_price: 5000 },
    { name: 'Long Skirt', description: 'Wash, Press & Hanged', base_price: 3500 },
    { name: 'Custom Ceremonials', description: 'Wash, Press & Hanged', base_price: 10000 },
    { name: 'Tshirts', description: 'Wash, Press & Hanged', base_price: 3000 },
    { name: 'Night Dress', description: 'Wash, Press & Hanged', base_price: 3000 },
    { name: 'Bath robe', description: 'Wash, Press & Hanged', base_price: 5000 },
    { name: 'Brassier', description: 'Wash, Press & Hanged', base_price: 3500 },
    { name: 'Blouse', description: 'Wash, Press & Hanged', base_price: 3500 },
    { name: 'Sweater', description: 'Wash, Press & Hanged', base_price: 5000 },
    { name: 'Towels - Face', description: 'Wash, Dry & Folded', base_price: 2000 },
    { name: 'Towels - Hand', description: 'Wash, Dry & Folded', base_price: 4000 },
    { name: 'Towels - Body', description: 'Wash, Dry & Folded', base_price: 6000 },
    { name: 'Bed Covers King', description: 'Wash, Press & Fold', base_price: 7000 },
    { name: 'Bed Covers Single', description: 'Wash, Press & Fold', base_price: 5000 },
    { name: 'Bed Sheet Double', description: 'Wash, Press & Fold', base_price: 4000 },
    { name: 'Bed Sheet Single', description: 'Wash, Press & Fold', base_price: 3000 },
    { name: 'Duvet/Conforter Large', description: 'Wash & Fold', base_price: 10000 },
    { name: 'Duvet/Conforter Medium', description: 'Wash & Fold', base_price: 8000 },
    { name: 'Sleeping Bags', description: 'Wash & Fold', base_price: 8000 },
    { name: 'Wedding Dress standard', description: 'Wash, Press & Hanged', base_price: 25000 },
    { name: 'Wedding Dress Large 4pc', description: 'Wash, Press & Hanged', base_price: 35000 },
    { name: 'Kikoi', description: 'Wash, Press & Hanged', base_price: 4000 },
    { name: 'Dollies', description: 'Washed Only (5,000 - 10,000)', base_price: 5000 },
    { name: 'Wash & Dry 1KG', description: 'Washed & Fold', base_price: 7000, price_per_kg: 7000 },
    { name: 'Wash Only 1KG', description: 'Washed & Fold', base_price: 3500, price_per_kg: 3500 }
  ];

  const allServices = [...serviceTypes, ...gentsServices, ...ladiesServices];

  const stmt = db.prepare(`INSERT OR IGNORE INTO services (name, description, base_price, price_per_item, price_per_kg) 
    VALUES (?, ?, ?, ?, ?)`);

  allServices.forEach(service => {
    stmt.run(service.name, service.description, service.base_price, 
      service.price_per_item || 0, service.price_per_kg || 0);
  });

  stmt.finalize();
  console.log('OK:  All services from price list inserted');
}

function insertDefaultSettings() {
  const settings = [
    { key: 'express_same_day_multiplier', value: '2', description: 'Express same-day delivery multiplier (2x = 100% surcharge)' },
    { key: 'express_next_day_multiplier', value: '3', description: 'Express next-day delivery multiplier (3x = 200% surcharge)' },
    { key: 'express_same_day_hours', value: '8', description: 'Same-day delivery time in hours (< 8HRS)' },
    { key: 'express_next_day_hours', value: '3', description: 'Next-day delivery time in hours (< 3HRS)' },
    { key: 'high_season_mode', value: 'false', description: 'High season mode - adjusts delivery to 24hrs working hours' },
    { key: 'sms_sending_enabled', value: 'true', description: 'Globally allow SMS sending to customers' }
  ];

  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (setting_key, setting_value, description) 
    VALUES (?, ?, ?)`);

  settings.forEach(setting => {
    stmt.run(setting.key, setting.value, setting.description);
  });

  stmt.finalize();
  console.log('OK:  Default settings inserted');
}

module.exports = db;
