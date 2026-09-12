/**
 * Single database entry point: use PostgreSQL when DATABASE_URL is set (e.g. Render, Supabase),
 * otherwise SQLite for local development. In production we REQUIRE DATABASE_URL so we never use SQLite.
 * When using PostgreSQL, get/all/run support optional callback as last arg (SQLite-style) for compatibility.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const isProduction = process.env.NODE_ENV === 'production';
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
if (isProduction && !process.env.DATABASE_URL && !isServerless) {
  console.error('');
  console.error('ERROR:  DATABASE_URL is required in production (e.g. on Render).');
  console.error('   Add it in Render: Dashboard → Your Service → Environment → Add variable:');
  console.error('   Key: DATABASE_URL');
  console.error('   Value: your Supabase connection string (from Supabase → Settings → Database).');
  console.error('');
  process.exit(1);
}

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
if (hasDatabaseUrl) {
  console.log(' Using PostgreSQL (DATABASE_URL set)');
  let query;
  try {
    query = require('./query');
  } catch (error) {
    console.error('Failed to load PostgreSQL query helper on serverless:', error && error.message ? error.message : error);
    throw new Error('PostgreSQL dependencies are unavailable. Please verify the deployment includes pg and set DATABASE_URL.');
  }
  const wrap = (fn) => function (sql, ...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const params = Array.isArray(args[0]) ? args[0] : args;
    const p = fn(sql, params);
    if (cb) {
      p.then((res) => cb(null, res)).catch((err) => cb(err, null));
      return;
    }
    return p;
  };
  const runCb = (fn) => function (sql, ...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const params = Array.isArray(args[0]) ? args[0] : args;
    const p = fn(sql, params);
    if (cb) {
      p.then((result) => {
        const ctx = { lastID: result?.row?.id ?? result?.lastID, changes: result?.changes ?? 0 };
        cb.call(ctx, null);
      }).catch((err) => cb.call({}, err));
      return;
    }
    return p;
  };
  module.exports = {
    ...query,
    get: wrap(query.get),
    all: wrap(query.all),
    run: runCb(query.run),
  };
} else if (isServerless) {
  const missingDbError = new Error('DATABASE_URL environment variable is required on Vercel. Set it to your PostgreSQL connection string.');
  console.error(missingDbError.message);
  const fail = () => {
    throw missingDbError;
  };
  module.exports = new Proxy({ then: undefined }, { get: (target, prop) => (prop === 'then' ? undefined : fail) });
} else {
  let initDb;
  try {
    // Keep sqlite3 out of static serverless bundles by requiring at runtime only.
    // eslint-disable-next-line global-require
    const runtimeRequire = eval('require');
    initDb = runtimeRequire('./init');
  } catch (error) {
    console.error('Failed to load SQLite database:', error && error.message ? error.message : error);
    throw new Error('SQLite is unavailable in this runtime. Set DATABASE_URL to use PostgreSQL.');
  }
  module.exports = initDb;
}
