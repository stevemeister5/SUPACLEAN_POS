/**
 * PostgreSQL Query Helper Functions
 * Provides wrapper functions that convert SQLite-style queries to PostgreSQL
 * This allows gradual migration from SQLite callback pattern to PostgreSQL promises
 */

const { Pool } = require('pg');
require('dotenv').config();

// Pool size: Supabase/Neon free tiers often cap concurrent connections; keep default modest (override with DATABASE_POOL_MAX).
const poolMax = (() => {
  const n = parseInt(process.env.DATABASE_POOL_MAX || '', 10);
  if (Number.isFinite(n) && n >= 1 && n <= 50) return n;
  return 12;
})();

// Create PostgreSQL connection pool
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires SSL for all connections
  ssl: process.env.DATABASE_URL?.includes('supabase') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false } 
    : false,
  max: poolMax,
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 10000, // Increased to 10 seconds for Supabase pooler
});

// Log first pool connection only (each schema module triggers its own query on startup).
let loggedPoolConnect = false;
dbPool.on('connect', () => {
  if (loggedPoolConnect) return;
  loggedPoolConnect = true;
  console.log('OK:  Connected to PostgreSQL database');
});

dbPool.on('error', (err) => {
  console.error('ERROR:  Unexpected error on idle PostgreSQL client', err);
  // Keep API process alive on transient pool/client faults.
  // Individual queries will still fail fast and surface meaningful errors.
});

/**
 * Convert SQLite query (with ? placeholders) to PostgreSQL ($1, $2, etc.)
 * @param {string} query - SQL query with ? placeholders
 * @param {Array} params - Array of parameters
 * @returns {Object} { query: converted query, params: params array }
 */
function convertQuery(query, params = []) {
  let paramIndex = 1;
  const convertedQuery = query.replace(/\?/g, () => `$${paramIndex++}`);
  return { query: convertedQuery, params };
}

/**
 * Execute query and return all rows (replaces db.all)
 * @param {string} sql - SQL query
 * @param {Array} params - Parameters
 * @returns {Promise<Array>} Rows array
 */
function all(sql, params = []) {
  const { query, params: convertedParams } = convertQuery(sql, params);
  return dbPool.query(query, convertedParams)
    .then(result => result.rows)
    .catch(err => {
      console.error('Database query error (all):', err);
      throw err;
    });
}

/**
 * Execute query and return first row (replaces db.get)
 * @param {string} sql - SQL query
 * @param {Array} params - Parameters
 * @returns {Promise<Object|null>} First row or null
 */
function get(sql, params = []) {
  const { query, params: convertedParams } = convertQuery(sql, params);
  return dbPool.query(query, convertedParams)
    .then(result => result.rows[0] || null)
    .catch(err => {
      console.error('Database query error (get):', err);
      throw err;
    });
}

/**
 * Execute query (replaces db.run for INSERT/UPDATE/DELETE)
 * @param {string} sql - SQL query
 * @param {Array} params - Parameters
 * @returns {Promise<Object>} Result with lastID, changes, row
 */
function run(sql, params = []) {
  const { query, params: convertedParams } = convertQuery(sql, params);
  return dbPool.query(query, convertedParams)
    .then(result => {
      // For INSERT, try to get the ID from RETURNING clause or result.rows[0]
      let lastID = null;
      if (result.rows && result.rows.length > 0 && result.rows[0].id) {
        lastID = result.rows[0].id;
      } else if (result.rows && result.rows.length > 0) {
        // Try common ID column names
        const firstRow = result.rows[0];
        lastID = firstRow.id || firstRow.ID || null;
      }
      
      return {
        lastID: lastID,
        changes: result.rowCount || 0,
        row: result.rows[0] || null
      };
    })
    .catch(err => {
      console.error('Database query error (run):', err);
      throw err;
    });
}

/**
 * Execute a raw query (advanced use)
 * @param {string} sql - SQL query (can use $1, $2, etc. directly)
 * @param {Array} params - Parameters
 * @returns {Promise<Object>} Query result
 */
function query(sql, params = []) {
  return dbPool.query(sql, params)
    .catch(err => {
      console.error('Database query error (query):', err);
      throw err;
    });
}

/**
 * Get the pool instance (for advanced use)
 * @returns {Pool} PostgreSQL pool instance
 */
function getPool() {
  return dbPool;
}

module.exports = {
  all,
  get,
  run,
  query,
  getPool,
  convertQuery,
  pool: dbPool
};
