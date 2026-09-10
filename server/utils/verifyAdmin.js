/**
 * Admin User Verification Script
 * 
 * This script checks if the admin user exists and creates it if missing.
 * Run this script if you're having login issues: node server/utils/verifyAdmin.js
 */

const db = require('../database/db');
const bcrypt = require('bcryptjs');

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';
const ADMIN_FULL_NAME = 'System Administrator';
const ADMIN_ROLE = 'admin';

function verifyAdmin() {
  console.log('SCAN:  Checking for admin user...\n');

  // Check if admin exists
  db.get('SELECT * FROM users WHERE username = ?', [ADMIN_USERNAME], (err, user) => {
    if (err) {
      console.error('ERROR:  Error checking admin user:', err.message);
      process.exit(1);
    }

    if (user) {
      console.log('OK:  Admin user found:');
      console.log('   ID:', user.id);
      console.log('   Username:', user.username);
      console.log('   Full Name:', user.full_name);
      console.log('   Role:', user.role);
      console.log('   Active:', user.is_active === 1 ? 'Yes' : 'No');
      console.log('   Branch ID:', user.branch_id || 'None (Admin access to all branches)');
      console.log('   Last Login:', user.last_login || 'Never');
      console.log('\nOK:  Admin user is ready to use!');
      console.log('   Username: admin');
      console.log('   Password: admin123');
      process.exit(0);
    } else {
      console.log('ERROR:  Admin user NOT found.');
      console.log('FIX:  Creating admin user...\n');

      // Hash password
      bcrypt.hash(ADMIN_PASSWORD, 10, (hashErr, passwordHash) => {
        if (hashErr) {
          console.error('ERROR:  Error hashing password:', hashErr.message);
          process.exit(1);
        }

        // Create admin user (no branch assigned - admin can access all branches)
        db.run(
          'INSERT INTO users (username, password_hash, full_name, role, branch_id, is_active) VALUES (?, ?, ?, ?, ?, ?)',
          [ADMIN_USERNAME, passwordHash, ADMIN_FULL_NAME, ADMIN_ROLE, null, 1],
          function(insertErr) {
            if (insertErr) {
              console.error('ERROR:  Error creating admin user:', insertErr.message);
              process.exit(1);
            }

            console.log('OK:  Admin user created successfully!');
            console.log('\nCHECK:  Admin Credentials:');
            console.log('   Username: admin');
            console.log('   Password: admin123');
            console.log('\nWARN: ️  IMPORTANT: Please change the password after first login!');
            console.log('\nOK:  You can now log in with these credentials.');
            process.exit(0);
          }
        );
      });
    }
  });
}

// Wait for database to be ready
setTimeout(() => {
  verifyAdmin();
}, 1000);
