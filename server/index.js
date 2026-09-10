const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction || process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}
function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildAllowedOrigins() {
  const values = [];
  const fromClientUrl = (process.env.CLIENT_URL || '')
    .split(',')
    .map((v) => normalizeOrigin(v))
    .filter(Boolean);
  const fromRenderExternal = normalizeOrigin(process.env.RENDER_EXTERNAL_URL);
  const fallbackLocal = ['http://localhost:3000'];
  values.push(...fromClientUrl);
  if (fromRenderExternal) values.push(fromRenderExternal);
  values.push(...fallbackLocal);
  return Array.from(new Set(values));
}

const allowedOrigins = buildAllowedOrigins();

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(compression());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.includes(normalized)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true
}));
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  next();
});

if (!isProduction) {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

require('./database/db');
require('./database/ensureBankingSchema');
require('./database/ensureNotificationsDedupeKey');
require('./database/ensureUsersAuthSchema');
require('./database/ensurePayrollSchema');
require('./database/ensureExpenseCategoriesSchema');
require('./database/ensureCleaningSchema');
require('./database/ensureOrderVoidSchema');
require('./database/ensureOrderArchiveSchema');
require('./database/ensureAdminInboxSchema');
require('./database/ensureReceiptSequenceSchema');
require('./database/ensureItemsSchema');
require('./database/ensurePerformanceIndexes');
require('./database/ensureLongevitySchema');
require('./database/ensureSmsMarketingSchema');
require('./database/ensureMonthlyBillingSchema');

try {
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/branches', require('./routes/branches'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/customers', require('./routes/customers'));
  app.use('/api/orders', require('./routes/orders'));
  app.use('/api/services', require('./routes/services'));
  app.use('/api/items', require('./routes/items'));
  app.use('/api/transactions', require('./routes/transactions'));
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/expenses', require('./routes/expenses'));
  app.use('/api/payroll', require('./routes/payroll'));
  app.use('/api/cash-management', require('./routes/cashManagement'));
  app.use('/api/bank-accounts', require('./routes/bankAccounts'));
  app.use('/api/bank-deposits', require('./routes/bankDeposits'));
  app.use('/api/loyalty', require('./routes/loyalty'));
  app.use('/api/validation', require('./routes/validation'));
  app.use('/api/order-item-photos', require('./routes/orderItemPhotos'));
  app.use('/api/delivery-notes', require('./routes/deliveryNotes'));
  app.use('/api/bills', require('./routes/bills'));
  app.use('/api/invoices', require('./routes/invoices'));
  app.use('/api/cleaning-documents', require('./routes/cleaningDocuments'));
  app.use('/api/cleaning-customers', require('./routes/cleaningCustomers'));
  app.use('/api/cleaning-expenses', require('./routes/cleaningExpenses'));
  app.use('/api/admin', require('./routes/adminData'));
  app.use('/api/admin/maintenance', require('./routes/adminMaintenance'));
  app.use('/api/admin/sms-marketing', require('./routes/adminSmsMarketing'));
  app.use('/api/admin/inbox', require('./routes/adminInbox'));
  app.use('/api/admin', require('./routes/auditExport'));
  console.log('OK:  All routes loaded successfully');
} catch (error) {
  console.error('ERROR:  Error loading routes:', error);
  console.error('Stack trace:', error.stack);
  process.exit(1);
}

app.get('/api/health', async (req, res) => {
  const started = Date.now();
  try {
    // Use the single database entry point: resolves to SQLite locally or
    // PostgreSQL when DATABASE_URL is set (query.js alone would fail on SQLite).
    const db = require('./database/db');
    await db.get('SELECT 1 AS ok', []);
    res.json({
      status: 'OK',
      message: 'SUPACLEAN POS API is running',
      database: 'connected',
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('Health check DB error:', err.message);
    res.status(503).json({
      status: 'DEGRADED',
      message: 'API is up but database is unreachable',
      database: 'unreachable',
      ...(isProduction ? {} : { error: err.message }),
    });
  }
});

const { authenticate, requireRole } = require('./middleware/auth');

app.get('/api/sms-status', authenticate, requireRole('admin'), (req, res) => {
  const provider = (process.env.SMS_PROVIDER || 'africastalking').toLowerCase();
  const hasApiKey = !!(process.env.SMS_API_KEY || (provider === 'twilio' && process.env.TWILIO_AUTH_TOKEN));
  const hasUsername = !!(provider !== 'africastalking' || process.env.SMS_USERNAME);
  const configured = hasApiKey && (provider !== 'africastalking' || hasUsername);
  const hints = [];
  if (!hasApiKey) hints.push('Set SMS_API_KEY in .env (Africa\'s Talking) or TWILIO_AUTH_TOKEN (Twilio).');
  if (provider === 'africastalking' && !hasUsername) hints.push('Set SMS_USERNAME in .env (e.g. "sandbox" or your app username).');
  if (configured && provider === 'africastalking') {
    hints.push('If SMS still does not send: check Africa\'s Talking account has credit; sender ID may need to be approved for Tanzania.');
  }
  res.json({ configured, provider, hasApiKey, hasUsername, hints });
});

app.use('/uploads', authenticate, express.static(path.join(__dirname, '../uploads'), {
  fallthrough: false,
}));

if (isProduction) {
  const buildDir = path.join(__dirname, '../client/build');
  const fs = require('fs');
  if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
    console.error('ERROR:  Frontend build missing. Run Build Command: npm run build:render');
    console.error('   Expected: client/build/index.html');
  }
  app.use(express.static(buildDir));
  app.get('*', (req, res) => {
    const indexPath = path.join(buildDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return res.status(503).json({
        error: 'Frontend not built. In Render, set Build Command to: npm run build:render',
        hint: 'Dashboard → Your Service → Settings → Build & Deploy → Build Command'
      });
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.sendFile(indexPath);
  });
}

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const status = err.status || 500;
  res.status(status).json({
    error: isProduction ? 'Internal server error' : (err.message || 'Internal server error'),
    ...(!isProduction && { stack: err.stack }),
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(` SUPACLEAN POS Server running on port ${PORT}`);
  console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ERROR:  Port ${PORT} is already in use. Please kill the process or use a different port.`);
    console.error(`Run: npm run kill-port`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

function gracefulShutdown(signal) {
  console.log(`\n${signal} signal received: closing HTTP server`);
  server.close(() => {
    console.log('HTTP server closed');
    const db = require('./database/db');
    if (typeof db.close === 'function') {
      db.close((err) => {
        if (err) console.error('Error closing database:', err.message);
        else console.log('Database connection closed');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });

  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});
