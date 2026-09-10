// Quick script to check and create admin user
const db = require('../database/db');
const bcrypt = require('bcryptjs');

setTimeout(() => {
  // Check if admin exists
  db.get('SELECT * FROM users WHERE username = ?', ['admin'], (err, user) => {
    if (err) {
      console.error('Error checking admin:', err);
      process.exit(1);
    }

    if (user) {
      console.log('OK:  Admin user exists:');
      console.log('   ID:', user.id);
      console.log('   Username:', user.username);
      console.log('   Role:', user.role);
      console.log('   Active:', user.is_active);
      console.log('   Branch ID:', user.branch_id);
      process.exit(0);
    } else {
      console.log('ERROR:  Admin user NOT found. Creating...');
      
      // Create admin user
      const password = 'admin123';
      bcrypt.hash(password, 10, (hashErr, passwordHash) => {
        if (hashErr) {
          console.error('Error hashing password:', hashErr);
          process.exit(1);
        }

        db.run(
          'INSERT INTO users (username, password_hash, full_name, role, branch_id, is_active) VALUES (?, ?, ?, ?, ?, ?)',
          ['admin', passwordHash, 'System Administrator', 'admin', null, 1],
          function(insertErr) {
            if (insertErr) {
              console.error('Error creating admin:', insertErr);
              process.exit(1);
            }

            console.log('OK:  Admin user created successfully!');
            console.log('   Username: admin');
            console.log('   Password: admin123');
            process.exit(0);
          }
        );
      });
    }
  });
}, 1000);
