/**
 * PostgreSQL Database Connection (Replacement for SQLite init.js)
 * This file will replace init.js after migration
 */

const { Pool } = require('pg');
require('dotenv').config();

// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
});

// Test connection
pool.on('connect', () => {
  console.log('OK:  Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('ERROR:  Unexpected error on idle PostgreSQL client', err);
  // Don't exit process - let application handle it
});

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('ERROR:  Error connecting to PostgreSQL:', err.message);
    console.error('   Make sure DATABASE_URL is set in .env file');
  } else {
    console.log('OK:  PostgreSQL connection test successful');
  }
});

// Export pool
module.exports = pool;

// Note: Table initialization is handled by schema migration in Supabase
// No need for initializeTables() function here
