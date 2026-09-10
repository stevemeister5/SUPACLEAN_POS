// Script to create default admin user
const db = require('../database/db');
const bcrypt = require('bcryptjs');

// Create default admin user
function createDefaultAdmin() {
  const defaultUsername = 'admin';
  const defaultPassword = 'admin123'; // Should be changed on first login
  const defaultFullName = 'System Administrator';

  // Check if admin already exists
  db.get('SELECT id FROM users WHERE username = ?', [defaultUsername], (err, existingUser) => {
    if (err) {
      console.error('Error checking for existing admin:', err);
      return;
    }

    if (existingUser) {
      console.log('OK:  Admin user already exists');
      return;
    }

    // Hash password
    bcrypt.hash(defaultPassword, 10, (hashErr, passwordHash) => {
      if (hashErr) {
        console.error('Error hashing password:', hashErr);
        return;
      }

      // Get default branch (Main Branch)
      db.get("SELECT id FROM branches WHERE code = 'AR01' LIMIT 1", [], (branchErr, branch) => {
        if (branchErr) {
          console.error('Error fetching default branch:', branchErr);
          return;
        }

        // Create admin user (no branch assigned - admin can access all branches)
        db.run(
          'INSERT INTO users (username, password_hash, full_name, role, branch_id, is_active) VALUES (?, ?, ?, ?, ?, ?)',
          [defaultUsername, passwordHash, defaultFullName, 'admin', null, 1],
          function(insertErr) {
            if (insertErr) {
              console.error('Error creating admin user:', insertErr);
              return;
            }

            console.log('OK:  Default admin user created');
            console.log('   Username: admin');
            console.log('   Password: admin123');
            console.log('   WARN: ️  Please change the password after first login!');
          }
        );
      });
    });
  });
}

// Run after a short delay to ensure database is initialized
setTimeout(() => {
  createDefaultAdmin();
}, 2000);

module.exports = { createDefaultAdmin };
